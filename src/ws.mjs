// Minimal RFC 6455 client (text messages, ping/pong, close) so the recorder runs on Node 20 without a global WebSocket.
import http from "node:http";
import crypto from "node:crypto";

export function connectWebSocket(url, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request({host: u.hostname, port: u.port, path: u.pathname + u.search, timeout: timeoutMs,
            headers: {Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64")}});
        req.on("upgrade", (res, socket, head) => resolve(new WsConnection(socket, head)));
        req.on("response", (res) => { res.resume(); reject(new Error(`${url}: websocket upgrade refused (HTTP ${res.statusCode})`)); });
        req.on("timeout", () => req.destroy(new Error(`${url}: websocket upgrade timed out`)));
        req.on("error", reject);
        req.end();
    });
}

class WsConnection {
    constructor(socket, head) {
        this.socket = socket;
        this.chunks = head && head.length ? [Buffer.from(head)] : [];
        this.size = this.chunks.length ? this.chunks[0].length : 0;
        this.fragments = [];
        this.closed = false;
        this.onmessage = null;
        this.onclose = null;
        socket.setNoDelay(true);
        socket.on("data", (d) => { this.chunks.push(d); this.size += d.length; this.parse(); });
        socket.on("close", () => { this.closed = true; if (this.onclose) this.onclose(); });
        socket.on("error", () => {});
        if (this.size) setImmediate(() => this.parse());
    }

    parse() {
        for (;;) {
            if (this.size < 2) return;
            const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size);
            this.chunks = [buf];
            let len = buf[1] & 0x7f, off = 2;
            if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
            const masked = (buf[1] & 0x80) !== 0, maskAt = off;
            if (masked) off += 4;
            if (buf.length < off + len) return;
            let payload = buf.subarray(off, off + len);
            if (masked) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskAt + (i & 3)]; }
            const rest = buf.subarray(off + len);
            this.chunks = rest.length ? [rest] : [];
            this.size = rest.length;
            const fin = (buf[0] & 0x80) !== 0, opcode = buf[0] & 0x0f;
            if (opcode === 8) { this.close(); return; }
            if (opcode === 9) { this.frame(10, payload); continue; }
            if (opcode === 10) continue;
            this.fragments.push(Buffer.from(payload));
            if (fin) {
                const text = Buffer.concat(this.fragments).toString("utf8");
                this.fragments = [];
                if (this.onmessage) this.onmessage(text);
            }
        }
    }

    frame(opcode, payload) {
        if (this.closed) throw new Error("websocket is closed");
        const len = payload.length, mask = crypto.randomBytes(4);
        const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
        head[0] = 0x80 | opcode;
        if (len < 126) head[1] = 0x80 | len;
        else if (len < 65536) { head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
        else { head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
        const body = Buffer.from(payload);
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
        this.socket.write(Buffer.concat([head, mask, body]));
    }

    send(text) { this.frame(1, Buffer.from(text, "utf8")); }

    close() {
        if (this.closed) return;
        try { this.frame(8, Buffer.alloc(0)); } catch { /* already gone */ }
        this.closed = true;
        this.socket.end();
    }
}
