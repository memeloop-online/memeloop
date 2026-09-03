import AddIcon from '@mui/icons-material/Add';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderIcon from '@mui/icons-material/Folder';
import { Box, IconButton, List, ListItemButton, ListItemIcon, ListItemText, Tooltip, Typography } from '@mui/material';
import { styled } from '@mui/material/styles';
import React, { useCallback, useState } from 'react';
import type { IProject } from '../../types';

export interface ProjectSessionListProps {
  projects: IProject[];
  activeSessionId?: string;
  onSessionClick?: (sessionId: string) => void;
  onCreateProject?: () => void;
  onCreateSession?: (projectId: string) => void;
  onDeleteProject?: (projectId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  onRenameProject?: (projectId: string, newName: string) => void;
  onRenameSession?: (sessionId: string, newName: string) => void;
  i18n?: {
    newProject?: string;
    newSession?: string;
    noSessions?: string;
  };
}

const SidebarSection = styled(Box)`
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 8px;
`;

const ProjectHeader = styled(Box)`
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  padding: 4px 8px;
  cursor: pointer;
  border-radius: 4px;
  &:hover {
    background-color: ${({ theme }) => theme.palette.action.hover};
  }
`;

const SessionItem = styled(ListItemButton)<{ $isActive?: boolean }>`
  padding-left: 32px;
  padding-top: 4px;
  padding-bottom: 4px;
  border-radius: 4px;
  background-color: ${({ theme, $isActive }) => $isActive ? theme.palette.action.selected : 'transparent'};
`;

const NewProjectButton = styled(IconButton)`
  width: 100%;
  justify-content: flex-start;
  padding: 8px;
  border-radius: 4px;
  margin-bottom: 4px;
`;

export const ProjectSessionList: React.FC<ProjectSessionListProps> = ({
  projects,
  activeSessionId,
  onSessionClick,
  onCreateProject,
  onCreateSession,
  i18n = {},
}) => {
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => {
    const set = new Set<string>();
    for (const p of projects) {
      set.add(p.id);
    }
    return set;
  });

  const toggleProject = useCallback((projectId: string) => {
    setExpandedProjects((previous) => {
      const next = new Set(previous);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }, []);

  const tNewProject = i18n.newProject ?? 'New Project';
  const tNewSession = i18n.newSession ?? 'New Session';
  const tNoSessions = i18n.noSessions ?? 'No sessions';

  return (
    <SidebarSection>
      {onCreateProject && (
        <NewProjectButton onClick={onCreateProject} size='small'>
          <AddIcon fontSize='small' sx={{ mr: 1 }} />
          <Typography variant='body2'>{tNewProject}</Typography>
        </NewProjectButton>
      )}

      {projects.map((project) => {
        const isExpanded = expandedProjects.has(project.id);
        return (
          <Box key={project.id}>
            <ProjectHeader
              onClick={() => {
                toggleProject(project.id);
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0 }}>
                <FolderIcon fontSize='small' color='action' />
                <Typography variant='body2' noWrap sx={{ minWidth: 0, fontWeight: 500 }}>
                  {project.name}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center' }}>
                {onCreateSession && (
                  <Tooltip title={tNewSession}>
                    <IconButton
                      size='small'
                      onClick={(event) => {
                        event.stopPropagation();
                        onCreateSession(project.id);
                      }}
                    >
                      <AddIcon fontSize='small' />
                    </IconButton>
                  </Tooltip>
                )}
                {isExpanded ? <ExpandLessIcon fontSize='small' /> : <ExpandMoreIcon fontSize='small' />}
              </Box>
            </ProjectHeader>

            {isExpanded && (
              <List dense disablePadding>
                {project.sessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    $isActive={session.id === activeSessionId}
                    onClick={() => {
                      onSessionClick?.(session.id);
                    }}
                  >
                    <ListItemIcon sx={{ minWidth: 28 }}>
                      <ChatBubbleOutlineIcon fontSize='small' />
                    </ListItemIcon>
                    <ListItemText
                      primary={session.name}
                      slotProps={{ primary: { variant: 'body2', noWrap: true } }}
                    />
                  </SessionItem>
                ))}
                {project.sessions.length === 0 && (
                  <Typography variant='caption' sx={{ pl: 4, color: 'text.secondary' }}>
                    {tNoSessions}
                  </Typography>
                )}
              </List>
            )}
          </Box>
        );
      })}
    </SidebarSection>
  );
};
