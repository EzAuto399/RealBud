import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/state/store', () => ({ api: vi.fn() }));
// A static render can't type. While `typing.on`, state keeps its value across renders in call
// order, so a test can change a field as its onChange would, render again and read the guard.
const typing = vi.hoisted(() => ({ on: false, at: 0, values: [] as unknown[], guards: [] as boolean[] }));
vi.mock('react', async original => {
  const react = await original<typeof import('react')>();
  return { ...react, useState: (initial: unknown) => {
    if (!typing.on) return react.useState(initial);
    const at = typing.at++;
    if (!(at in typing.values)) typing.values[at] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [typing.values[at], (next: unknown) => { typing.values[at] = typeof next === 'function' ? (next as (old: unknown) => unknown)(typing.values[at]) : next; }];
  } };
});
vi.mock('@/lib/unsaved-work', async original => ({ ...await original<object>(), useUnsavedGuard: (dirty: boolean) => { typing.guards.push(dirty); } }));
afterEach(() => { typing.on = false; typing.values.length = 0; });
const answer = (element: ReturnType<typeof createElement>) => { typing.at = 0; typing.guards.length = 0; renderToStaticMarkup(element); return [...typing.guards]; };
import type { ConnectorEntryView, ConnectorRegistryView } from '@shared/mcp-connector';
import type { ConnectorRegistryControls } from '@/lib/mcp-connector-api';
import { ConnectorReview, OfficeConnectors } from './ConnectorReview';

const connection = (status: 'connected' | 'not_connected') => ({ version: 1 as const, connector: 'fictional-books', status, generation: 1, reason: null, canManage: true,
  account: status === 'connected' ? { label: '3 tools', verifiedAt: 1_780_000_000_000 } : null });
const entry = (patch: Partial<ConnectorEntryView> = {}): ConnectorEntryView => ({
  id: 'fictional-books', label: 'Fictional Books', serverUrl: 'https://mcp.fictional-books.example/mcp', auth: 'oauth', builtIn: false, state: 'pending_review',
  reviewedAt: null, proposalDigest: 'a'.repeat(64), oversized: false, connection: connection('connected'),
  tools: [
    { name: 'list_books', toolClass: 'read', description: '<img src=x onerror=alert(1)> List books', enabled: false, trusted: false },
    { name: 'create_book', toolClass: 'write', description: 'Create a book', enabled: false, trusted: false },
    { name: 'send_invoice', toolClass: 'consequential', description: 'Send an invoice', enabled: false, trusted: false },
  ], ...patch });
function controls(view: ConnectorRegistryView | null): ConnectorRegistryControls {
  const ok = vi.fn(async () => true);
  return { state: { view, loading: false, readError: null, busy: null, notice: null }, refresh: vi.fn(async () => {}), add: ok, review: ok, remove: ok, setToken: ok, check: ok, disconnect: ok, connect: ok };
}
const buttons = (markup: string) => [...markup.matchAll(/<button [^>]*>(.*?)<\/button>/g)].map(match => match[1].replace(/<[^>]+>/g, ''));

describe('connector review', () => {
  it('lists tools with class and escaped description, everything off by default', () => {
    const markup = renderToStaticMarkup(createElement(ConnectorReview, { entry: entry(), busy: false, onApprove: vi.fn(), onCancel: vi.fn() }));
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt; List books');
    expect(markup).not.toContain('<img');
    for (const name of ['list_books', 'create_book', 'send_invoice']) expect(markup).not.toMatch(new RegExp(`aria-label="Allow ${name}" checked`));
    expect(markup).toContain('Looks read-only · asks you each time unless trusted');
    expect(markup).toContain('Consequential action · may send, pay, delete or change access');
    expect(markup).not.toMatch(/\bMCP\b|\bbroker\b|\bHermes\b/);
  });

  it('offers a trusted mark only on an enabled read-looking tool, and holds approval until the consequential warning is accepted', () => {
    const reviewed = entry({ tools: [
      { name: 'list_books', toolClass: 'read', description: '', enabled: true, trusted: true },
      { name: 'create_book', toolClass: 'write', description: '', enabled: true, trusted: false },
      { name: 'send_invoice', toolClass: 'consequential', description: '', enabled: true, trusted: false },
    ] });
    const markup = renderToStaticMarkup(createElement(ConnectorReview, { entry: reviewed, busy: false, onApprove: vi.fn(), onCancel: vi.fn() })).replace(/&#x27;/g, "'");
    expect(markup).toMatch(/aria-label="Trust list_books to read without asking" checked=""/);
    expect(markup).not.toContain('Trust create_book');
    expect(markup).not.toContain('Trust send_invoice');
    expect(markup).toContain("RealBud can't verify what this service does; the card shows only the arguments the tool receives.");
    expect(markup).toMatch(/<button type="button" class="[^"]*" disabled="">Approve and turn on/);
  });
});

describe('added services in Connected apps', () => {
  it('lets the owner add, connect, review, disconnect and remove, and shows Needs review on drift', () => {
    const markup = renderToStaticMarkup(createElement(OfficeConnectors, { controls: controls({ version: 1, canManage: true, connectors: [entry({ state: 'quarantined' })] }) })).replace(/&#x27;/g, "'");
    expect(markup).toContain('aria-label="Server address"');
    expect(markup).toContain('Needs review · the service changed its tools');
    expect(buttons(markup)).toEqual(['Add connector', 'Check for Fictional Books', 'Review tools for Fictional Books', 'Disconnect for Fictional Books', 'Remove for Fictional Books']);
    expect(markup).not.toMatch(/\bMCP\b|\bbroker\b/);
  });

  it('shows members the status only, and a token field (never a value) for token services', () => {
    const member = renderToStaticMarkup(createElement(OfficeConnectors, { controls: controls({ version: 1, canManage: false, connectors: [entry({ state: 'active' })] }) }));
    expect(member).not.toContain('aria-label="Server address"');
    expect(buttons(member)).toEqual(['Check for Fictional Books']);
    const owner = renderToStaticMarkup(createElement(OfficeConnectors, { controls: controls({ version: 1, canManage: true, connectors: [entry({ auth: 'header', connection: connection('not_connected') })] }) }));
    expect(owner).toMatch(/type="password" autoComplete="off" aria-label="Access token for Fictional Books"[^>]*value=""/);
  });
});

describe('unsaved connector choices and text', () => {
  it('holds beforeunload and the update restart while review choices differ from the saved ones', () => {
    const review = createElement(ConnectorReview, { entry: entry(), busy: false, onApprove: vi.fn(), onCancel: vi.fn() });
    typing.on = true;
    expect(answer(review)).toEqual([false]);
    typing.values[0] = new Set(['create_book']); // Allow create_book ticked
    expect(answer(review)).toEqual([true]);
    typing.values[0] = new Set();
    expect(answer(review)).toEqual([false]);
  });

  it('holds them while a server address, name or access token is typed', () => {
    const office = createElement(OfficeConnectors, { controls: controls({ version: 1, canManage: true, connectors: [entry({ auth: 'header', connection: connection('not_connected') })] }) });
    typing.on = true;
    expect(answer(office)).toEqual([false, false]); // the add form, then the token field
    const [address, token] = [0, typing.values.lastIndexOf('')]; // the first state is the server address; the row's last is its token
    typing.values[address] = 'https://mcp.fictional-books.example/mcp';
    expect(answer(office)).toEqual([true, false]);
    typing.values[address] = '';
    typing.values[token] = 'fictional-token-value';
    expect(answer(office)).toEqual([false, true]);
  });
});
