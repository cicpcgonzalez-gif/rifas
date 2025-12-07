# Prisma en rifas-backend

1. Instala dependencias:
   npm install
2. Crea la base de datos PostgreSQL y ajusta la variable `DATABASE_URL` en `.env`.
3. Ejecuta la migración inicial:
   npm run migrate
4. Usa Prisma Client en tu código:
   const { PrismaClient } = require('@prisma/client');
   const prisma = new PrismaClient();
