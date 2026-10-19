// Prisma 7 config: only the schema path (generate needs no database URL; the adapter gets it at runtime).
import { defineConfig } from 'prisma/config';
export default defineConfig({ schema: 'prisma/schema.prisma' });
