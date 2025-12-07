# Rifas Backend

Backend en Node.js con Express, Prisma y PostgreSQL para una aplicación de rifas.

## Características

- ✅ Express.js como servidor web
- ✅ Prisma ORM con PostgreSQL
- ✅ Autenticación JWT
- ✅ Rutas protegidas y públicas
- ✅ ESLint configurado
- ✅ Jest para pruebas
- ✅ Listo para deploy en Render

## Estructura del Proyecto

```
rifas/
├── src/
│   ├── config/
│   │   └── database.js       # Configuración de Prisma
│   ├── middleware/
│   │   └── auth.js            # Middleware de autenticación JWT
│   ├── routes/
│   │   ├── auth.js            # Rutas de autenticación (register, login)
│   │   ├── health.js          # Health check (público)
│   │   └── raffles.js         # CRUD de rifas (protegido)
│   └── index.js               # Servidor principal
├── prisma/
│   └── schema.prisma          # Esquema de base de datos
├── __tests__/
│   └── app.test.js            # Tests
├── .env                       # Variables de entorno (no versionar)
├── .env.example               # Ejemplo de variables de entorno
├── package.json               # Dependencias y scripts
└── jest.config.js             # Configuración de Jest
```

## Requisitos Previos

- Node.js 18+ 
- PostgreSQL 14+
- npm o yarn

## Instalación

1. Clonar el repositorio:
```bash
git clone https://github.com/cicpcgonzalez-gif/rifas.git
cd rifas
```

2. Instalar dependencias:
```bash
npm install
```

3. Configurar variables de entorno:
```bash
cp .env.example .env
```

Editar `.env` con tus credenciales:
```env
DATABASE_URL="postgresql://user:password@localhost:5432/rifas?schema=public"
JWT_SECRET="tu-secret-key-seguro"
PORT=3000
NODE_ENV=development
```

4. Generar Prisma Client:
```bash
npm run build
```

5. Ejecutar migraciones (cuando tengas la base de datos):
```bash
npm run prisma:migrate
```

## Scripts Disponibles

```bash
# Desarrollo con hot reload
npm run dev

# Producción
npm start

# Generar Prisma Client
npm run build

# Tests
npm test
npm run test:watch
npm run test:coverage

# Linting
npm run lint
npm run lint:fix

# Prisma
npm run prisma:generate   # Generar cliente
npm run prisma:migrate    # Ejecutar migraciones en desarrollo
npm run prisma:deploy     # Ejecutar migraciones en producción
```

## Endpoints

### Públicos

- `GET /health` - Health check
- `GET /status` - Status check
- `POST /auth/register` - Registrar usuario
- `POST /auth/login` - Login de usuario

### Protegidos (requieren JWT token)

- `GET /raffles` - Listar todas las rifas
- `GET /raffles/:id` - Obtener una rifa específica
- `POST /raffles` - Crear nueva rifa
- `PUT /raffles/:id` - Actualizar rifa
- `DELETE /raffles/:id` - Eliminar rifa

## Autenticación

### Registro
```bash
POST /auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword",
  "name": "John Doe"
}
```

### Login
```bash
POST /auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword"
}
```

Respuesta:
```json
{
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "John Doe"
  }
}
```

### Usar el token
```bash
GET /raffles
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## Modelo de Datos

### User
- `id` - UUID
- `email` - String (único)
- `password` - String (hasheado)
- `name` - String (opcional)
- `createdAt` - DateTime
- `updatedAt` - DateTime

### Raffle
- `id` - UUID
- `title` - String
- `description` - String (opcional)
- `price` - Float
- `totalTickets` - Int
- `soldTickets` - Int (default: 0)
- `status` - String (default: "active")
- `createdAt` - DateTime
- `updatedAt` - DateTime

## Deploy en Render

1. Crear una cuenta en [Render](https://render.com)

2. Crear un PostgreSQL database:
   - Copiar la DATABASE_URL interna

3. Crear un Web Service:
   - Conectar tu repositorio de GitHub
   - Configurar:
     - Build Command: `npm install && npm run build && npm run prisma:deploy`
     - Start Command: `npm start`
   
4. Agregar variables de entorno:
   - `DATABASE_URL` - URL de tu PostgreSQL de Render
   - `JWT_SECRET` - Un string aleatorio seguro
   - `NODE_ENV` - `production`
   - `PORT` - (Render lo configura automáticamente)

5. Deploy automático cada vez que hagas push a main

## Testing

```bash
# Ejecutar todos los tests
npm test

# Ejecutar con cobertura
npm run test:coverage

# Modo watch
npm run test:watch
```

## Linting

```bash
# Verificar código
npm run lint

# Auto-fix issues
npm run lint:fix
```

## Seguridad

- Las contraseñas se hashean con bcrypt
- Autenticación basada en JWT
- Tokens expiran en 24 horas
- Variables de entorno para secrets
- CORS habilitado

## Contribuir

1. Fork el proyecto
2. Crea una rama para tu feature (`git checkout -b feature/AmazingFeature`)
3. Commit tus cambios (`git commit -m 'Add some AmazingFeature'`)
4. Push a la rama (`git push origin feature/AmazingFeature`)
5. Abre un Pull Request

## Licencia

Este proyecto está bajo la licencia especificada en el archivo LICENSE.

