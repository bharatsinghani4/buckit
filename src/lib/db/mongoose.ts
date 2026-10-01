import "server-only";
import mongoose from "mongoose";
import { requireConfig } from "@/lib/config/required";

// Reused across hot reloads and warm function calls; not shared across instances.
const globalForMongo = globalThis as typeof globalThis & {
  buckitMongoConnection?: Promise<typeof mongoose>;
};

export function connectDatabase(): Promise<typeof mongoose> {
  if (!globalForMongo.buckitMongoConnection) {
    const uri = requireConfig("MONGODB_URI", process.env.MONGODB_URI);
    const dbName = requireConfig("MONGODB_DB_NAME", process.env.MONGODB_DB_NAME);
    globalForMongo.buckitMongoConnection = mongoose
      .connect(uri, {
        dbName,
        maxPoolSize: 5,
        minPoolSize: 0,
        serverSelectionTimeoutMS: 5_000,
        connectTimeoutMS: 10_000,
        bufferCommands: false,
        autoIndex: false,
        autoCreate: false,
      })
      .catch((error: unknown) => {
        globalForMongo.buckitMongoConnection = undefined;
        throw error;
      });
  }
  return globalForMongo.buckitMongoConnection;
}
