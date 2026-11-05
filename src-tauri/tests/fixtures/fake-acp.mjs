// A fake ACP agent for tests: newline-delimited JSON-RPC over stdio. During a prompt turn it asks
// for a permission and to read a file (both must be refused), then streams two text chunks.
// FAKE_ACP_LOG: file to append every message it receives. FAKE_ACP_SLOW: wait for cancel.
// FAKE_ACP_DIE: exit mid-turn with a message on stderr.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (m) => process.env.FAKE_ACP_LOG && appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(m) + "\n");
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const waiting = new Map();
let nextId = 100;
let promptId = null;
let cancelled = false;

function ask(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}
const chunk = (text) =>
  send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });

async function turn(id) {
  promptId = id;
  await ask("session/request_permission", {
    sessionId: "s1",
    toolCall: { toolCallId: "t1", title: "Read file" },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  });
  await ask("fs/read_text_file", { sessionId: "s1", path: "/etc/hosts" });
  if (process.env.FAKE_ACP_DIE) {
    process.stderr.write("agent crashed: out of tokens\n");
    process.exit(3);
  }
  if (process.env.FAKE_ACP_SLOW) {
    while (!cancelled) await new Promise((r) => setTimeout(r, 20));
    chunk("late");
    send({ id, result: { stopReason: "cancelled" } });
    return;
  }
  chunk("Hello ");
  chunk("world");
  send({ id, result: { stopReason: "end_turn" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  log(m);
  if (m.id !== undefined && !m.method) {
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
    return;
  }
  switch (m.method) {
    case "initialize":
      return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    case "session/new":
      return send({ id: m.id, result: { sessionId: "s1" } });
    case "session/prompt":
      return void turn(m.id);
    case "session/cancel":
      cancelled = true;
      return;
    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: "unknown" } });
  }
});
