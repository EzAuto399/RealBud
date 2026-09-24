/** Outbound-only command transport. Credentials never enter renderer contracts. */
export const WEBSITE_REQUESTS_ORIGIN = 'https://realbud.app';
export class WebsiteRequestsTransportError extends Error {
    status;
    constructor(status) {
        super(status === 401 || status === 403 ? 'Website request access is no longer active.' : 'The website could not confirm this request. Reconnect and try again.');
        this.status = status;
    }
}
const routes = ['command-grants', 'commands/poll', 'commands/ack', 'commands/claim', 'v2/command-grants', 'v2/command-grants/cancel', 'v2/remote-approvers/begin', 'v2/remote-approvers/clock', 'v2/remote-approvers/status', 'v2/remote-approvers/confirm', 'v2/remote-approvers/revoke', 'v2/work/poll', 'v2/work/review', 'v2/work/claim', 'v2/work/ack', 'v2/work/cancel', 'v2/work/prune'];
export function createWebsiteRequestsTransport(fetcher = fetch) {
    const active = new Set();
    return {
        async post(route, token, body, parse, method = 'POST') {
            if (!routes.includes(route) || !/^[a-f0-9]{64}$/.test(token))
                throw new WebsiteRequestsTransportError(400);
            const encoded = JSON.stringify(body);
            if (Buffer.byteLength(encoded) > (route === 'v2/work/review' ? 128_000 : 64_000))
                throw new WebsiteRequestsTransportError(413);
            const controller = new AbortController();
            active.add(controller);
            const timer = setTimeout(() => controller.abort(), 10_000);
            timer.unref();
            let reader;
            try {
                const url = `${WEBSITE_REQUESTS_ORIGIN}/api/installations/${route}`;
                const response = await fetcher(url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: encoded, redirect: 'error', signal: controller.signal });
                if (response.redirected || (response.url && response.url !== url))
                    throw new WebsiteRequestsTransportError(502);
                if (!response.ok)
                    throw new WebsiteRequestsTransportError(response.status);
                if (response.headers.get('content-type')?.split(';')[0] !== 'application/json')
                    throw new WebsiteRequestsTransportError(502);
                reader = response.body?.getReader();
                if (!reader)
                    throw new WebsiteRequestsTransportError(502);
                const chunks = [];
                let length = 0;
                while (true) {
                    const item = await reader.read();
                    if (item.done)
                        break;
                    length += item.value.byteLength;
                    if (length > 256_000)
                        throw new WebsiteRequestsTransportError(413);
                    chunks.push(item.value);
                }
                return parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            }
            catch (error) {
                if (error instanceof WebsiteRequestsTransportError)
                    throw error;
                // Network and server parser messages can contain private data/URLs.
                throw new WebsiteRequestsTransportError(502);
            }
            finally {
                clearTimeout(timer);
                active.delete(controller);
                controller.abort();
                await reader?.cancel().catch(() => { });
            }
        },
        abort() { for (const controller of active)
            controller.abort(); },
    };
}
