// Bot + thread persistence. bots.json holds bot records (including the
// thread→instance binding and per-instance resume cursors — upstream's
// ProviderSessionDirectory, recipe step 6: persist the binding from day
// one). messages-<threadId>.json holds the folded transcript.
import { readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { DATA_DIR } from "./config.js";
import { newId } from "./contracts.js";
import { pickBotName } from "./names.js";
import { redactSecretsInText } from "./redact.js";
import { HERMES_MEMORY_APPROVAL, validMemoryApprovalReview } from "../shared/approval-policy.js";
/** What a task is called before its first message names it. */
export const UNTITLED_TASK = "New task";
/** A task's name, taken from the first thing you asked it to do. */
export function titleFromMessage(text) {
    const line = text.trim().split("\n")[0].trim();
    return line.length > 48 ? `${line.slice(0, 47)}…` : line || UNTITLED_TASK;
}
const BOTS_FILE = join(DATA_DIR, "bots.json");
const GROUPS_FILE = join(DATA_DIR, "groups.json");
const messagesFile = (threadId) => join(DATA_DIR, `messages-${threadId}.json`);
const COLORS = [
    "green",
    "blue",
    "red",
    "orange",
    "purple",
    "cyan",
    "pink",
    "yellow",
    "teal",
    "coral",
];
/** Resolve @mentions in a message against a bot roster: `@` must start a
 * word, the name must end on a word boundary (so "@New Bottle" never matches
 * "New Bot"), names match case-insensitively, longest name wins (so
 * "@New Bot 2" never half-matches "New Bot"), hidden bots skipped, results
 * deduped. Callers pre-filter the sender out of `peers`. */
export function mentionedBots(text, peers) {
    const candidates = peers
        .filter((p) => !p.hidden && p.name.trim())
        .sort((a, b) => b.name.length - a.name.length);
    const lower = text.toLowerCase();
    const found = [];
    let at = -1;
    while ((at = lower.indexOf("@", at + 1)) !== -1) {
        if (at > 0 && !/\s/.test(text[at - 1]))
            continue; // user@host, not a tag
        const rest = lower.slice(at + 1);
        const hit = candidates.find((p) => {
            const name = p.name.toLowerCase();
            if (!rest.startsWith(name))
                return false;
            const after = rest[name.length]; // must not run into a longer word
            return after === undefined || !/[a-z0-9]/i.test(after);
        });
        if (hit && !found.includes(hit))
            found.push(hit);
    }
    return found;
}
/** Normalize persisted or API-provided routing. Old rooms did not have this
 * field; giving them their first member as lead fixes the old silent-send
 * behavior without making every prompt fan out to every model. */
export function normalizeGroupDefaultResponder(value, memberIds, dm = false) {
    if (dm)
        return { kind: "mentions" };
    if (value && typeof value === "object") {
        const candidate = value;
        if (candidate.kind === "everyone")
            return { kind: "everyone" };
        if (candidate.kind === "mentions")
            return { kind: "mentions" };
        if (candidate.kind === "member" &&
            typeof candidate.botId === "string" &&
            memberIds.includes(candidate.botId)) {
            return { kind: "member", botId: candidate.botId };
        }
    }
    if (memberIds.length === 0)
        return { kind: "mentions" };
    return { kind: "member", botId: memberIds[0] };
}
/** Resolve the bots invoked by a human room message. Explicit targets win;
 * otherwise the room policy chooses one member, everyone, or nobody. */
export function roomResponders(text, members, defaultResponder) {
    const available = members.filter((member) => !member.hidden);
    if (/(?:^|\s)@everyone\b/i.test(text))
        return available;
    const mentioned = mentionedBots(text, available);
    if (mentioned.length)
        return mentioned;
    if (defaultResponder.kind === "everyone")
        return available;
    if (defaultResponder.kind === "member") {
        const lead = available.find((member) => member.id === defaultResponder.botId);
        return lead ? [lead] : [];
    }
    return [];
}
const onboardingCard = () => ({
    title: "What should I help with first?",
    subtitle: "This is an assistant chat. The morning arrears board is on Desk.",
    options: ["Owner update", "Repair triage", "Lease enquiry", "Something else"],
});
export class Store {
    bots = [];
    groups = [];
    threads = new Map();
    defaultSelection;
    constructor(defaultSelection) {
        this.defaultSelection = defaultSelection;
        mkdirSync(DATA_DIR, { recursive: true });
        try {
            this.bots = JSON.parse(readFileSync(BOTS_FILE, "utf8"));
        }
        catch {
            this.bots = [];
        }
        try {
            this.groups = JSON.parse(readFileSync(GROUPS_FILE, "utf8"));
        }
        catch {
            this.groups = [];
        }
        // busy never survives a restart — no turn does either. Rooms saved
        // before default responders existed adopt their first member as lead.
        let botsMigrated = false;
        let chiefSeen = false;
        let groupsMigrated = false;
        for (const b of this.bots) {
            b.busy = false;
            const queued = b.queuedMessage;
            if (queued !== undefined &&
                (!queued ||
                    typeof queued.id !== "string" ||
                    typeof queued.text !== "string" ||
                    !queued.text.trim() ||
                    typeof queued.at !== "number" ||
                    !Number.isFinite(queued.at) ||
                    typeof queued.threadId !== "string")) {
                delete b.queuedMessage;
                botsMigrated = true;
            }
            else if (queued?.heldReason !== undefined &&
                queued.heldReason !== "connected-app-settings-changed" && queued.heldReason !== "review-required") {
                // Unknown future/corrupt hold metadata must not release saved work.
                queued.heldReason = "review-required";
                botsMigrated = true;
            }
        }
        for (const b of this.bots) {
            if (!b.chiefOfStaff)
                continue;
            if (!chiefSeen) {
                chiefSeen = true;
                if (b.hidden) {
                    b.hidden = false;
                    botsMigrated = true;
                }
                continue;
            }
            b.chiefOfStaff = false;
            botsMigrated = true;
        }
        for (const g of this.groups) {
            g.busyBotId = null;
            const normalized = normalizeGroupDefaultResponder(g.defaultResponder, g.memberIds, Boolean(g.dm));
            if (JSON.stringify(normalized) !== JSON.stringify(g.defaultResponder))
                groupsMigrated = true;
            g.defaultResponder = normalized;
        }
        if (botsMigrated)
            this.saveBots();
        if (groupsMigrated)
            this.saveGroups();
        // bots saved before tasks existed have one endless thread; adopt it as
        // their first task so nothing is lost and nothing special-cases it
        for (const b of this.bots) {
            if (b.tasks?.length)
                continue;
            b.tasks = [
                {
                    threadId: b.threadId,
                    title: this.firstUserLine(b.threadId) ?? UNTITLED_TASK,
                    createdAt: b.createdAt,
                    resumeCursors: b.resumeCursors ?? {},
                },
            ];
        }
        // A task may have been removed by an older build while its queued item
        // survived. Never deliver that instruction into a different task.
        for (const b of this.bots) {
            if (!b.queuedMessage)
                continue;
            const knownThreads = new Set([b.threadId, ...(b.tasks ?? []).map((task) => task.threadId)]);
            if (knownThreads.has(b.queuedMessage.threadId))
                continue;
            delete b.queuedMessage;
            botsMigrated = true;
        }
        if (botsMigrated)
            this.saveBots();
    }
    saveBots() {
        writeFileAtomic(BOTS_FILE, JSON.stringify(this.bots, null, 2));
    }
    saveGroups() {
        writeFileAtomic(GROUPS_FILE, JSON.stringify(this.groups.map(({ busyBotId, ...g }) => g), null, 2));
    }
    // ── groups ────────────────────────────────────────────────────────────
    group(id) {
        return this.groups.find((g) => g.id === id);
    }
    groupByThread(threadId) {
        return this.groups.find((g) => g.threadId === threadId);
    }
    createGroup(name, memberIds, dm = false) {
        const group = {
            id: newId(),
            threadId: newId(),
            name,
            memberIds,
            defaultResponder: dm ? { kind: "mentions" } : { kind: "member", botId: memberIds[0] },
            bulletin: "",
            unread: false,
            createdAt: Date.now(),
            dm: dm || undefined,
            busyBotId: null,
        };
        this.groups.unshift(group);
        this.saveGroups();
        return group;
    }
    /** The bot⇄bot channel for a pair, if it exists (order-insensitive). */
    dmGroup(a, b) {
        return this.groups.find((g) => g.dm && g.memberIds.length === 2 && g.memberIds.includes(a) && g.memberIds.includes(b));
    }
    patchGroup(id, patch) {
        const group = this.group(id);
        if (!group)
            return null;
        Object.assign(group, patch);
        group.defaultResponder = normalizeGroupDefaultResponder(group.defaultResponder, group.memberIds, Boolean(group.dm));
        this.saveGroups();
        return group;
    }
    deleteGroup(id) {
        const group = this.group(id);
        if (!group)
            return false;
        this.groups = this.groups.filter((g) => g.id !== id);
        this.threads.delete(group.threadId);
        this.saveGroups();
        try {
            unlinkSync(messagesFile(group.threadId));
        }
        catch { }
        return true;
    }
    /** Toggle an emoji reaction on a message ("user" or a member botId). */
    toggleReaction(threadId, messageId, emoji, by) {
        const existing = this.messagesFor(threadId).find((m) => m.id === messageId);
        if (!existing)
            return null;
        const reactions = existing.reactions ?? [];
        const at = reactions.findIndex((r) => r.emoji === emoji && r.by === by);
        const next = at >= 0 ? reactions.filter((_, i) => i !== at) : [...reactions, { emoji, by }];
        return this.patchMessage(threadId, messageId, { reactions: next.length ? next : undefined });
    }
    thread(threadId) {
        let t = this.threads.get(threadId);
        if (t)
            return t;
        let messages = [];
        let activeLeafId = null;
        try {
            const raw = JSON.parse(readFileSync(messagesFile(threadId), "utf8"));
            if (Array.isArray(raw))
                messages = raw; // pre-branching flat file
            else {
                messages = raw.messages ?? [];
                activeLeafId = raw.activeLeafId ?? null;
            }
        }
        catch {
            /* fresh thread */
        }
        // legacy rows carry no parentId — chain them in array order
        let prev = null;
        for (const m of messages) {
            if (m.parentId === undefined)
                m.parentId = prev;
            prev = m.id;
        }
        if (!activeLeafId)
            activeLeafId = messages.at(-1)?.id ?? null;
        t = { messages, activeLeafId };
        this.threads.set(threadId, t);
        return t;
    }
    saveThread(threadId) {
        const t = this.thread(threadId);
        writeFileAtomic(messagesFile(threadId), JSON.stringify({ activeLeafId: t.activeLeafId, messages: t.messages }, null, 2));
    }
    messagesFor(threadId) {
        return this.thread(threadId).messages;
    }
    activeLeaf(threadId) {
        return this.thread(threadId).activeLeafId;
    }
    /** The visible conversation: root → activeLeafId. */
    activePath(threadId) {
        const t = this.thread(threadId);
        const byId = new Map(t.messages.map((m) => [m.id, m]));
        const path = [];
        let cur = t.activeLeafId ? byId.get(t.activeLeafId) : undefined;
        while (cur) {
            path.push(cur);
            cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
        return path.reverse();
    }
    appendMessage(threadId, message) {
        const t = this.thread(threadId);
        const full = { id: newId(), at: Date.now(), parentId: t.activeLeafId, ...message };
        if (full.role === "bot") {
            if (full.text)
                full.text = redactSecretsInText(full.text);
            if (full.tool?.name)
                full.tool = { ...full.tool, name: redactSecretsInText(full.tool.name) };
            if (full.card) {
                full.card = {
                    ...full.card,
                    title: redactSecretsInText(full.card.title),
                    subtitle: redactSecretsInText(full.card.subtitle),
                };
                // Never preserve a credential-bearing or partial memory preview and
                // then let it authorize the original unseen native change.
                if (full.card.tool === HERMES_MEMORY_APPROVAL) {
                    const review = full.card.memoryReview;
                    if (!validMemoryApprovalReview(review) || redactSecretsInText(review.description) !== review.description || redactSecretsInText(review.content) !== review.content) {
                        delete full.card.memoryReview;
                    }
                    full.card.approvalPolicy = 'once';
                    delete full.card.allowKey;
                }
            }
        }
        t.messages.push(full);
        t.activeLeafId = full.id;
        if (full.kind === "screen")
            this.pruneScreenFrames(t);
        this.saveThread(threadId);
        return full;
    }
    /** Screen frames are ~100-500KB of base64 each and the whole thread file
     * is rewritten on every append, so keeping every frame of a long
     * computer session makes each later message slower than the last. The
     * newest few keep their pixels; older ones stay in the transcript as
     * placeholders. Mirrors the client's own frame cap. */
    pruneScreenFrames(t, keep = 4) {
        let seen = 0;
        for (let i = t.messages.length - 1; i >= 0 && seen < t.messages.length; i--) {
            const m = t.messages[i];
            if (m.kind !== "screen" || !m.png)
                continue;
            seen += 1;
            if (seen > keep)
                m.png = undefined;
        }
    }
    /** Fork the conversation: a new user message that replaces `sourceId`
     * (same parent, new text) and becomes the active leaf. */
    branchMessage(threadId, sourceId, text) {
        const t = this.thread(threadId);
        const source = t.messages.find((m) => m.id === sourceId);
        if (!source)
            return null;
        const full = {
            id: newId(),
            at: Date.now(),
            role: "user",
            kind: "text",
            text,
            parentId: source.parentId ?? null,
        };
        t.messages.push(full);
        t.activeLeafId = full.id;
        this.saveThread(threadId);
        return full;
    }
    /** Point the visible conversation at the branch containing `messageId`,
     * descending to that branch's most recently active leaf. */
    setActiveLeaf(threadId, messageId) {
        const t = this.thread(threadId);
        if (!t.messages.some((m) => m.id === messageId))
            return null;
        let cur = messageId;
        for (;;) {
            const children = t.messages.filter((m) => m.parentId === cur);
            if (!children.length)
                break;
            cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
        }
        t.activeLeafId = cur;
        this.saveThread(threadId);
        return cur;
    }
    patchMessage(threadId, messageId, patch) {
        const t = this.thread(threadId);
        const idx = t.messages.findIndex((m) => m.id === messageId);
        if (idx === -1)
            return null;
        t.messages[idx] = { ...t.messages[idx], ...patch, card: patch.card ?? t.messages[idx].card };
        this.saveThread(threadId);
        return t.messages[idx];
    }
    /** A stopped or restarted provider can no longer answer its old request.
     * Settle every orphaned card so the composer never stays locked forever. */
    settleOpenRequests(threadId, behavior = "deny") {
        const t = this.thread(threadId);
        const patched = [];
        t.messages = t.messages.map((message) => {
            if (message.kind !== "options" || !message.card?.requestId || message.card.answered || message.card.dismissed) {
                return message;
            }
            const next = {
                ...message,
                card: { ...message.card, answered: behavior, dismissed: true },
            };
            patched.push(next);
            return next;
        });
        if (patched.length)
            this.saveThread(threadId);
        return patched;
    }
    bot(id) {
        return this.bots.find((b) => b.id === id) ?? null;
    }
    /** Fresh installs use id `bud`; upgraded installs keep the old id (often a
     * UUID) with name Bud. Channels and Ask both talk to this one worker. */
    productBud() {
        return this.bot("bud")
            ?? this.bots.find((b) => b.name === "Bud")
            ?? this.bots[0]
            ?? null;
    }
    botByThread(threadId) {
        return this.bots.find((b) => b.threadId === threadId || b.tasks?.some((t) => t.threadId === threadId)) ?? null;
    }
    createBot() {
        const name = pickBotName(this.bots.map((b) => b.name));
        const bot = {
            id: newId(),
            threadId: newId(),
            name,
            title: "",
            description: "",
            notifications: true,
            color: COLORS[this.bots.length % COLORS.length],
            unread: false,
            modelSelection: this.defaultSelection(),
            resumeCursors: {},
            createdAt: Date.now(),
        };
        bot.tasks = [{ threadId: bot.threadId, title: UNTITLED_TASK, createdAt: bot.createdAt, resumeCursors: {} }];
        this.bots.unshift(bot);
        this.saveBots();
        this.appendMessage(bot.threadId, {
            role: "bot",
            kind: "text",
            text: `I'm ${name}, an assistant in RealBud. Morning arrears live on Desk — I can help draft owner notes and replies here.`,
        });
        this.appendMessage(bot.threadId, { role: "bot", kind: "options", card: onboardingCard() });
        return bot;
    }
    deleteBot(id) {
        const bot = this.bot(id);
        if (!bot)
            return false;
        this.bots = this.bots.filter((b) => b.id !== id);
        // every task's transcript goes with the bot, not just the open one
        for (const threadId of new Set([bot.threadId, ...(bot.tasks ?? []).map((t) => t.threadId)])) {
            this.threads.delete(threadId);
            try {
                unlinkSync(messagesFile(threadId));
            }
            catch { }
        }
        this.saveBots();
        return true;
    }
    patchBot(id, patch) {
        const bot = this.bot(id);
        if (!bot)
            return null;
        Object.assign(bot, patch);
        this.saveBots();
        return bot;
    }
    /** Adopt the existing visible assistant as Bud without changing its id or
     * thread. Older RealBud builds created a named assistant before product
     * mode introduced the canonical `bud` record; preserving those identifiers
     * keeps transcripts, rooms, reactions, and channel references intact.
     *
     * Passing a selection is an authoritative worker rebind. Provider cursors
     * cannot cross that boundary, so every task starts a fresh session and
     * replays its surviving transcript on the next turn. */
    adoptBud(selection) {
        const bot = this.bot("bud") ?? this.bots[0] ?? null;
        if (!bot)
            return null;
        let changed = false;
        if (bot.name !== "Bud") {
            bot.name = "Bud";
            changed = true;
        }
        if (bot.computer !== "off") {
            bot.computer = "off";
            changed = true;
        }
        if (selection?.instanceId &&
            (bot.modelSelection.instanceId !== selection.instanceId || bot.modelSelection.model !== selection.model)) {
            bot.modelSelection = { ...selection };
            bot.resumeCursors = {};
            for (const task of bot.tasks ?? [])
                task.resumeCursors = {};
            bot.rewound = true;
            changed = true;
        }
        if (changed)
            this.saveBots();
        return bot;
    }
    /** Set or replace the one queued follow-up for a task. */
    setQueuedMessage(botId, text, threadId) {
        const bot = this.bot(botId);
        const trimmed = text.trim();
        const targetThread = threadId ?? bot?.threadId;
        if (!bot || !trimmed || !targetThread || !this.taskByThread(botId, targetThread))
            return null;
        const queued = {
            id: newId(),
            text: trimmed,
            at: Date.now(),
            threadId: targetThread,
        };
        bot.queuedMessage = queued;
        this.saveBots();
        return queued;
    }
    /** Clear the slot, optionally only when it still contains the expected
     * item. The id guard keeps a stale UI click from deleting a replacement. */
    clearQueuedMessage(botId, expectedId) {
        const bot = this.bot(botId);
        const queued = bot?.queuedMessage;
        if (!bot || !queued || (expectedId && queued.id !== expectedId))
            return null;
        delete bot.queuedMessage;
        this.saveBots();
        return queued;
    }
    /** Preserve the instruction while removing automatic dispatch authority.
     * The id guard prevents an old caller from holding a replacement. */
    holdQueuedMessage(botId, reason, expectedId) {
        const queued = this.bot(botId)?.queuedMessage;
        if (!queued || (expectedId && queued.id !== expectedId))
            return null;
        if (queued.heldReason !== reason) {
            queued.heldReason = reason;
            this.saveBots();
        }
        return queued;
    }
    /** Atomically claim the queued follow-up before dispatching it. Callers may
     * restore the same item if dispatch fails before a turn is accepted. */
    takeQueuedMessage(botId, threadId) {
        const bot = this.bot(botId);
        const queued = bot?.queuedMessage;
        if (!bot || !queued || queued.heldReason !== undefined || (threadId && queued.threadId !== threadId))
            return null;
        delete bot.queuedMessage;
        this.saveBots();
        return queued;
    }
    restoreQueuedMessage(botId, queued) {
        const bot = this.bot(botId);
        if (!bot || bot.queuedMessage || !this.taskByThread(botId, queued.threadId))
            return false;
        bot.queuedMessage = { ...queued };
        this.saveBots();
        return true;
    }
    /** Elect one Chief of Staff (or clear the role) as one persisted change.
     * The changed records are returned so the server can update every open
     * window, including the bot that just handed the role over. */
    setChiefOfStaff(id) {
        if (id && !this.bot(id))
            return null;
        const changed = [];
        for (const bot of this.bots) {
            const next = bot.id === id;
            if (Boolean(bot.chiefOfStaff) === next && !(next && bot.hidden))
                continue;
            if (next) {
                bot.chiefOfStaff = true;
                // The workspace's main contact must stay reachable in the sidebar.
                bot.hidden = false;
            }
            else {
                bot.chiefOfStaff = false;
            }
            changed.push(bot);
        }
        if (changed.length)
            this.saveBots();
        return changed;
    }
    setResumeCursor(botId, instanceId, cursor, threadId) {
        const bot = this.bot(botId);
        if (!bot)
            return;
        // the cursor belongs to the task that produced it, not to the bot
        const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
        if (task)
            task.resumeCursors[instanceId] = cursor;
        // The legacy mirror follows the task visible in chat, never a detached
        // routine task working in the background.
        if (!threadId || bot.threadId === threadId)
            bot.resumeCursors[instanceId] = cursor;
        this.saveBots();
    }
    /** A resumed session can be pinned to a dead model/provider; dropping the
     * cursor lets the next turn start a fresh session on the current attach. */
    clearResumeCursor(botId, instanceId, threadId) {
        const bot = this.bot(botId);
        if (!bot)
            return;
        const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
        if (task)
            delete task.resumeCursors[instanceId];
        if (!threadId || bot.threadId === threadId)
            delete bot.resumeCursors[instanceId];
        this.saveBots();
    }
    // ── tasks ─────────────────────────────────────────────────────────────
    /** The first thing the human asked in a thread — a task's natural name. */
    firstUserLine(threadId) {
        const first = this.messagesFor(threadId).find((m) => m.role === "user" && m.kind === "text" && m.text?.trim());
        return first?.text ? titleFromMessage(first.text) : null;
    }
    tasks(botId) {
        return this.bot(botId)?.tasks ?? [];
    }
    activeTask(botId) {
        const bot = this.bot(botId);
        return bot?.tasks?.find((t) => t.threadId === bot.threadId);
    }
    taskByThread(botId, threadId) {
        return this.bot(botId)?.tasks?.find((t) => t.threadId === threadId);
    }
    /** A fresh context on the same bot: new thread, new session, same
     * persona/tools/computer. Becomes the active task. */
    createTask(botId, title, activate = true) {
        const bot = this.bot(botId);
        if (!bot)
            return null;
        const task = {
            threadId: newId(),
            title: title?.trim() || UNTITLED_TASK,
            createdAt: Date.now(),
            resumeCursors: {},
        };
        bot.tasks = [task, ...(bot.tasks ?? [])];
        if (activate) {
            bot.threadId = task.threadId;
            bot.resumeCursors = {}; // legacy mirror follows the active task
        }
        this.saveBots();
        return task;
    }
    switchTask(botId, threadId) {
        const bot = this.bot(botId);
        const task = bot?.tasks?.find((t) => t.threadId === threadId);
        if (!bot || !task)
            return null;
        bot.threadId = task.threadId;
        bot.resumeCursors = { ...task.resumeCursors };
        this.saveBots();
        return bot;
    }
    renameTask(botId, threadId, title) {
        const task = this.bot(botId)?.tasks?.find((t) => t.threadId === threadId);
        if (!task)
            return null;
        task.title = title.trim().slice(0, 80) || UNTITLED_TASK;
        this.saveBots();
        return task;
    }
    /** Name a task after its first message, once. */
    titleTaskFromFirstMessage(botId, text, threadId) {
        const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
        if (!task || task.title !== UNTITLED_TASK)
            return;
        task.title = titleFromMessage(text);
        this.saveBots();
    }
    /** Delete a task and its transcript. A bot always keeps one. */
    deleteTask(botId, threadId) {
        const bot = this.bot(botId);
        if (!bot || !bot.tasks || bot.tasks.length < 2)
            return null;
        if (!bot.tasks.some((t) => t.threadId === threadId))
            return null;
        bot.tasks = bot.tasks.filter((t) => t.threadId !== threadId);
        if (bot.queuedMessage?.threadId === threadId)
            delete bot.queuedMessage;
        this.threads.delete(threadId);
        try {
            unlinkSync(messagesFile(threadId));
        }
        catch { }
        if (bot.threadId === threadId) {
            bot.threadId = bot.tasks[0].threadId;
            bot.resumeCursors = { ...bot.tasks[0].resumeCursors };
        }
        this.saveBots();
        return bot;
    }
    /** One visible worker. Desk is home; Ask talks to Bud. */
    seedIfEmpty() {
        if (this.bots.some((b) => b.id === "bud"))
            return;
        if (this.bots.length)
            return;
        const bot = {
            id: "bud",
            threadId: newId(),
            name: "Bud",
            title: "Desk assistant",
            description: "Ask about the book. Morning exceptions stay on Desk for you to allow.",
            notifications: true,
            color: "green",
            unread: false,
            modelSelection: this.defaultSelection(),
            resumeCursors: {},
            computer: "off",
            createdAt: Date.now(),
        };
        bot.tasks = [{ threadId: bot.threadId, title: UNTITLED_TASK, createdAt: bot.createdAt, resumeCursors: {} }];
        this.bots.unshift(bot);
        this.saveBots();
        this.appendMessage(bot.threadId, {
            role: "bot",
            kind: "text",
            text: "I'm Bud. Morning money lives on Desk — I can help you read a card or draft an owner note. I never send or pay.",
        });
    }
}
