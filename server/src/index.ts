import { createApp } from "./app.js";
import { config } from "./config.js";
import { store } from "./store.js";
import { Worker } from "./worker.js";

const worker = new Worker(2);
const app = createApp(worker);

app.listen(config.port, () => {
  console.log(`Video Review server on ${config.publicBaseUrl}  (data in ${config.dataDir})`);
  console.log(`CORS origins: ${config.webOrigins.join(", ")}`);
  if (!config.groqApiKey) {
    console.warn("GROQ_API_KEY is not set. Reviews will fail at the transcription step until it is. See server/.env.example.");
  } else {
    console.log(`Transcription: Groq ${config.groqModel}`);
  }
  if (!process.env.SIGNING_SECRET) console.warn("SIGNING_SECRET is not set. Upload and playback links stop working when the server restarts.");
  worker.resume();
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    store.flush();
    process.exit(0);
  });
}
