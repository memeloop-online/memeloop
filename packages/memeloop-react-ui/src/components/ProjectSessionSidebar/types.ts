import type { IProject } from '../types';

export interface ProjectSessionSidebarProps {
  projects: IProject[];
  activeSessionId?: string;
  onSessionClick?: (sessionId: string) => void;
  onCreateProject?: () => void;
  onCreateSession?: (projectId: string) => void;
  onDeleteProject?: (projectId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  onRenameProject?: (projectId: string, newName: string) => void;
  onRenameSession?: (sessionId: string, newName: string) => void;
}
