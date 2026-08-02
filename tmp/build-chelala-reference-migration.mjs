import fs from "node:fs";
import path from "node:path";

const source = "tmp/chelala-reference-audit";
const target = "tmp/chelala-reference-migration-2";
const oldId = "ks72bcjvqg7x7kh607bgkvpb9582t42e";
const newId = "ks701p56ga16fwmvsb89cejakn8bbe06";

fs.mkdirSync(target);

for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const input = path.join(source, entry.name, "documents.jsonl");
  if (!fs.existsSync(input)) continue;

  let changed = 0;
  const lines = fs.readFileSync(input, "utf8").split(/\r?\n/).filter(Boolean);
  const output = lines.map((line) => {
    const doc = JSON.parse(line);
    if (doc.shop_id !== oldId) return line;
    doc.shop_id = newId;
    changed++;
    return JSON.stringify(doc);
  });

  if (!changed) continue;
  const directory = path.join(target, entry.name);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "documents.jsonl"), `${output.join("\n")}\n`);
  console.log(`${entry.name}: ${changed}`);
}
