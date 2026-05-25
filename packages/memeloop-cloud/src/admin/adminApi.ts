import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { db } from "../db";

export interface Agent {
  id: string;
  name: string;
  type: "build" | "plan" | "explore" | "oracle" | "librarian";
  description: string;
  skills: string[];
  prompt: string;
}

export interface Skill {
  id: string;
  name: string;
  instructions: string;
  tools: string[];
}

const listAgents = db.prepare("SELECT * FROM agents");
const getAgent = db.prepare("SELECT * FROM agents WHERE id = ?");
const insertAgent = db.prepare(
  "INSERT INTO agents (id, name, type, description, skills, prompt) VALUES (?, ?, ?, ?, ?, ?)"
);
const updateAgent = db.prepare(
  "UPDATE agents SET name = ?, type = ?, description = ?, skills = ?, prompt = ? WHERE id = ?"
);
const deleteAgent = db.prepare("DELETE FROM agents WHERE id = ?");

const listSkills = db.prepare("SELECT * FROM skills");
const getSkill = db.prepare("SELECT * FROM skills WHERE id = ?");
const insertSkill = db.prepare(
  "INSERT INTO skills (id, name, instructions, tools) VALUES (?, ?, ?, ?)"
);
const updateSkill = db.prepare(
  "UPDATE skills SET name = ?, instructions = ?, tools = ? WHERE id = ?"
);
const deleteSkill = db.prepare("DELETE FROM skills WHERE id = ?");

function rowToAgent(row: any): Agent {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description ?? "",
    skills: JSON.parse(row.skills ?? "[]"),
    prompt: row.prompt ?? "",
  };
}

function rowToSkill(row: any): Skill {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions ?? "",
    tools: JSON.parse(row.tools ?? "[]"),
  };
}

const adminApi: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Agents CRUD
  fastify.get("/api/admin/agents", async (_request, reply) => {
    const rows = listAgents.all();
    reply.send({ agents: rows.map(rowToAgent) });
  });

  fastify.post("/api/admin/agents", async (request, reply) => {
    const body = request.body as Omit<Agent, "id"> & { id?: string };
    const id = body.id ?? `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    insertAgent.run(
      id,
      body.name,
      body.type,
      body.description ?? "",
      JSON.stringify(body.skills ?? []),
      body.prompt ?? ""
    );
    const row = getAgent.get(id);
    reply.code(201).send(rowToAgent(row));
  });

  fastify.put("/api/admin/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Omit<Agent, "id">;
    const existing = getAgent.get(id);
    if (!existing) {
      reply.code(404).send({ error: "Agent not found" });
      return;
    }
    updateAgent.run(
      body.name,
      body.type,
      body.description ?? "",
      JSON.stringify(body.skills ?? []),
      body.prompt ?? "",
      id
    );
    const row = getAgent.get(id);
    reply.send(rowToAgent(row));
  });

  fastify.delete("/api/admin/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    deleteAgent.run(id);
    reply.code(204).send();
  });

  // Skills CRUD
  fastify.get("/api/admin/skills", async (_request, reply) => {
    const rows = listSkills.all();
    reply.send({ skills: rows.map(rowToSkill) });
  });

  fastify.post("/api/admin/skills", async (request, reply) => {
    const body = request.body as Omit<Skill, "id"> & { id?: string };
    const id = body.id ?? `skill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    insertSkill.run(
      id,
      body.name,
      body.instructions ?? "",
      JSON.stringify(body.tools ?? [])
    );
    const row = getSkill.get(id);
    reply.code(201).send(rowToSkill(row));
  });

  fastify.put("/api/admin/skills/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Omit<Skill, "id">;
    const existing = getSkill.get(id);
    if (!existing) {
      reply.code(404).send({ error: "Skill not found" });
      return;
    }
    updateSkill.run(
      body.name,
      body.instructions ?? "",
      JSON.stringify(body.tools ?? []),
      id
    );
    const row = getSkill.get(id);
    reply.send(rowToSkill(row));
  });

  fastify.delete("/api/admin/skills/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    deleteSkill.run(id);
    reply.code(204).send();
  });
};

export default adminApi;
