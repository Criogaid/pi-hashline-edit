// Emit protocol records for real-process smoke and termination checks.
const chunks = JSON.parse(process.argv[2]);
for (const chunk of chunks) {
  await new Promise((resolve) => process.stdout.write(Buffer.from(chunk, "base64"), resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
if (process.argv[3] === "wait") setInterval(() => {}, 1000);
