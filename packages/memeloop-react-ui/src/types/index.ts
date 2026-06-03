export interface IProject {
  id: string;
  name: string;
  sessions: ISession[];
}

export interface ISession {
  id: string;
  name: string;
  projectId: string;
  agentId?: string;
  createdAt: number;
  updatedAt: number;
}
