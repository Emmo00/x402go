# Express TypeScript Mongoose Swagger Template

An opinionated, production-ready backend template built with Express.js, TypeScript, MongoDB (Mongoose), and Swagger documentation. This template provides a solid foundation for building scalable REST APIs with comprehensive documentation, validation, testing, and security features.

## Features

- **TypeScript**: Full TypeScript support with strict type checking
- **Express.js**: Fast, unopinionated web framework for Node.js
- **MongoDB & Mongoose**: Document database with ODM for data modeling
- **Swagger/OpenAPI**: Auto-generated API documentation with Swagger UI
- **Input Validation**: Request validation using class-validator and DTOs
- **Error Handling**: Centralized error handling middleware
- **Security**: Helmet, CORS, HPP protection out of the box
- **Testing**: Jest configuration with supertest for API testing
- **Docker**: Docker Compose setup for development
- **Code Quality**: ESLint, Prettier, and strict TypeScript configuration
- **Environment Variables**: Secure environment variable handling with validation
- **Logging**: Request logging with Morgan
- **PM2 Ready**: Production process management support

## Project Structure

```
src/
├── controllers/         # Route controllers
├── dtos/               # Data Transfer Objects for validation
├── exceptions/         # Custom exception classes
├── middlewares/        # Express middlewares
├── models/            # Mongoose schemas and models
├── routes/            # Route definitions
├── services/          # Business logic layer
├── swagger-docs/      # Swagger/OpenAPI documentation
├── utils/             # Utility functions
├── @types/            # Global TypeScript type definitions
├── app.ts             # Express app configuration
└── server.ts          # Server entry point
```

## Tech Stack

- **Runtime**: Node.js
- **Language**: TypeScript
- **Framework**: Express.js
- **Database**: MongoDB with Mongoose ODM
- **Documentation**: Swagger/OpenAPI 3.0
- **Validation**: class-validator & class-transformer
- **Testing**: Jest & Supertest
- **Security**: Helmet, CORS, HPP
- **Process Manager**: PM2 (optional)
- **Containerization**: Docker & Docker Compose

## Getting Started

### Prerequisites

- Node.js (v16 or higher)
- MongoDB (local installation or MongoDB Atlas)
- npm or yarn package manager

### Installation

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd express-typescript-mongoose-swagger-template
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` file with your configuration:
   ```env
   NODE_ENV=development
   PORT=3033
   MONGODB_URI=mongodb://localhost:27017/your-database-name
   ```

4. **Start MongoDB**
   - Local: Start your MongoDB service
   - Docker: `docker-compose up -d mongo`

5. **Run the application**
   ```bash
   # Development mode with hot reload
   npm run dev
   
   # Production mode
   npm start
   
   # Build for production
   npm run build
   ```

## Docker Development

Run the entire stack with Docker Compose:

```bash
# Start all services (app + MongoDB)
docker-compose up

# Start in detached mode
docker-compose up -d

# Stop all services
docker-compose down
```

## API Documentation

Once the server is running, visit:
- **Swagger UI**: `http://localhost:3033/api-docs`
- **OpenAPI JSON**: `http://localhost:3033/api-docs.json`

The API documentation is automatically generated from your route definitions and Swagger comments.

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start the production server |
| `npm run dev` | Start development server with hot reload |
| `npm run build` | Build TypeScript to JavaScript |
| `npm test` | Run Jest tests |
| `npm run lint` | Run ESLint |
| `npm run cpm` | Start with PM2 process manager |

## Security Features

- **Helmet**: Sets various HTTP headers for security
- **CORS**: Configurable Cross-Origin Resource Sharing
- **HPP**: HTTP Parameter Pollution protection
- **Input Validation**: DTO-based request validation
- **Error Handling**: Secure error responses without sensitive data leakage

## Usage Examples

### Creating a New Route

1. **Define the model** (`src/models/example.model.ts`)
2. **Create DTO** (`src/dtos/example.dto.ts`)
3. **Implement service** (`src/services/example.service.ts`)
4. **Create controller** (`src/controllers/example.controller.ts`)
5. **Define routes** (`src/routes/example.route.ts`)
6. **Add Swagger documentation** (`src/swagger-docs/example.yaml`)

### Environment Variables

Validate environment variables in `src/utils/validateEnv.ts`:

```typescript
import { cleanEnv, port, str } from 'envalid';

const validateEnv = () => {
  cleanEnv(process.env, {
    NODE_ENV: str(),
    PORT: port(),
    MONGODB_URI: str(),
  });
};
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Original template inspiration from [vipinkavlar/node-express-typescript-mongodb-swagger](https://github.com/vipinkavlar/node-express-typescript-mongodb-swagger.git)
- Built with modern best practices for Node.js backend development

---

**Happy coding!**
