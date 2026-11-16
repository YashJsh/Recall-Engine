import "dotenv/config";
import { GroqSemanticFactExtractor, type ExtractionMessage } from "../src/semantic-fact-extractor.js";

const messages: ExtractionMessage[] = [
  {
    id: "demo-user-1",
    role: "user",
    content: "Use Redis directly for working memory. I've implemented map-based memory many times already.",
  },
  {
    id: "demo-assistant-1",
    role: "assistant",
    content: "Understood. We'll use Redis for working memory and skip another in-memory Map implementation.",
  },
  {
    id: "demo-user-2",
    role: "user",
    content: "Yes, exactly.",
  },
];

const extractor = new GroqSemanticFactExtractor();
const candidates = await extractor.extract(messages);

console.log("Proposed semantic facts (not saved):");
console.log(JSON.stringify(candidates, null, 2));
console.log("Source messages:");
for (const candidate of candidates) {
  const source = messages.find((message) => message.id === candidate.sourceMessageId);
  console.log(`- ${candidate.sourceMessageId}: ${source?.content}`);
}
