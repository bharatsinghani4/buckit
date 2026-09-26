import { existsSync } from "node:fs";
import mongoose from "mongoose";
import { connectDatabase } from "../src/lib/db/mongoose";
import { phaseOneModels } from "../src/lib/db/models";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
try {
  await connectDatabase();
  for (const model of phaseOneModels) {
    await model.createCollection();
    await model.createIndexes();
    console.log(`Ready: ${model.collection.collectionName}`);
  }
  console.log("Phase 1 collections and indexes are ready. Existing indexes were not dropped.");
} catch {
  console.error(
    "Database setup failed. Check the MongoDB configuration, database permissions, and network access.",
  );
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
