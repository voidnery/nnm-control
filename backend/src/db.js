import mongoose from 'mongoose';
import { config } from './config.js';

export async function connectDb() {
  mongoose.set('strictQuery', true);
  // Retry loop: mongo container may start slower than backend.
  for (let attempt = 1; ; attempt++) {
    try {
      await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
      console.log('[db] connected');
      return;
    } catch (e) {
      console.error(`[db] connect failed (attempt ${attempt}): ${e.message}`);
      if (attempt >= 30) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}
