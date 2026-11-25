// End-to-end check of the running bridge on 8788.
const base = "http://127.0.0.1:8788/v1";

async function post(body, stream) {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get("content-type"), text };
}

const noSystem = await post({
  model: "glm-5.3-flash",
  messages: [{ role: "user", content: "Reply with exactly: no system ok" }],
  stream: false,
});
console.log("no-system  ", noSystem.status, noSystem.type);
try {
  const json = JSON.parse(noSystem.text);
  console.log("  content  ", JSON.stringify(json.choices?.[0]?.message?.content));
} catch {
  console.log("  body     ", noSystem.text.slice(0, 200));
}

const streamed = await post({
  model: "deepseek-v4.1-flash",
  messages: [
    { role: "system", content: "You are terse." },
    { role: "user", content: "Count 1 to 5 comma separated, nothing else." },
  ],
  stream: true,
  stream_options: { include_usage: true },
});
const chunks = streamed.text.split("\n").filter((l) => l.startsWith("data:"));
let joined = "";
for (const line of chunks) {
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") continue;
  const parsed = JSON.parse(data);
  joined += parsed.choices?.[0]?.delta?.content ?? "";
}
console.log("stream     ", streamed.status, streamed.type, `chunks=${chunks.length}`, JSON.stringify(joined));

const tool = await post({
  model: "glm-5.3-flash",
  messages: [
    { role: "system", content: "Use the tool when asked." },
    { role: "user", content: "What is the weather in Tokyo? Use the tool." },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather for a city",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    },
  ],
  stream: false,
});
try {
  const json = JSON.parse(tool.text);
  const call = json.choices?.[0]?.message?.tool_calls?.[0];
  console.log("tool       ", tool.status, json.choices?.[0]?.finish_reason, call ? `${call.function.name} ${call.function.arguments}` : "(no call)");
} catch {
  console.log("tool       ", tool.status, tool.text.slice(0, 200));
}
