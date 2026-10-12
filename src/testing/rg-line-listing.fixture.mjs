// Emit protocol bytes in separate writes so parser tests exercise chunk boundaries.
const chunks = JSON.parse(process.argv[2]);
for (const chunk of chunks) {
  await new Promise((resolve) => process.stdout.write(Buffer.from(chunk, "base64"), resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
if (process.argv[3] === "wait") setInterval(() => {}, 1000);
