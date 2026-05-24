const API_BASE = "/api/admin";

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

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  agents: {
    list: () => fetchJson<{ agents: Agent[] }>(`${API_BASE}/agents`),
    create: (agent: Omit<Agent, "id">) =>
      fetchJson<Agent>(`${API_BASE}/agents`, { method: "POST", body: JSON.stringify(agent) }),
    update: (id: string, agent: Omit<Agent, "id">) =>
      fetchJson<Agent>(`${API_BASE}/agents/${id}`, { method: "PUT", body: JSON.stringify(agent) }),
    delete: (id: string) =>
      fetchJson<void>(`${API_BASE}/agents/${id}`, { method: "DELETE" }),
  },
  skills: {
    list: () => fetchJson<{ skills: Skill[] }>(`${API_BASE}/skills`),
    create: (skill: Omit<Skill, "id">) =>
      fetchJson<Skill>(`${API_BASE}/skills`, { method: "POST", body: JSON.stringify(skill) }),
    update: (id: string, skill: Omit<Skill, "id">) =>
      fetchJson<Skill>(`${API_BASE}/skills/${id}`, { method: "PUT", body: JSON.stringify(skill) }),
    delete: (id: string) =>
      fetchJson<void>(`${API_BASE}/skills/${id}`, { method: "DELETE" }),
  },
};
