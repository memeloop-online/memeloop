import Fastify from "fastify";
import cors from "@fastify/cors";
import adminApi from "./admin/adminApi";

export async function createServer() {
  const fastify = Fastify({ logger: true });
  await fastify.register(cors, { origin: true });
  await fastify.register(adminApi);
  return fastify;
}

export async function startServer(port = 3000) {
  const fastify = await createServer();
  await fastify.listen({ port, host: "0.0.0.0" });
  return fastify;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  startServer(port);
}
