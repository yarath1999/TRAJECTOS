import dotenv from "dotenv";
import path from "path";

/*
Loads environment variables when running scripts outside Next.js
*/

const envPath = path.resolve(process.cwd(), ".env.local");

dotenv.config({ path: envPath });

export {};