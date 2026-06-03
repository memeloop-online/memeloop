import SettingsIcon from '@mui/icons-material/Settings';
import UpgradeIcon from '@mui/icons-material/Upgrade';
import { styled } from '@mui/material/styles';
import { IconButton as IconButtonRaw, Tooltip } from '@mui/material';
import React from 'react';
import { ProjectSessionList, type ProjectSessionListProps } from '../ProjectSessionList';

const SidebarRoot = styled('div')`
  height: 100%;
  -webkit-app-region: drag;
  user-select: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-bottom: 10px;
  box-sizing: border-box;
  overflow-y: auto;
  overflow-x: hidden;
  &::-webkit-scrollbar {
    width: 0;
  }
  width: ${({ theme }) => (theme as any).sidebar?.width ?? 200}px;
  min-width: ${({ theme }) => (theme as any).sidebar?.width ?? 200}px;
  background-color: ${({ theme }) => theme.palette.background.default};
`;

const SidebarTop = styled('div')<{ $titleBar?: boolean }>`
  overflow-y: scroll;
  &::-webkit-scrollbar {
    width: 0;
  }
  flex: 1;
  width: 100%;
  padding-top: ${({ $titleBar }) => ($titleBar ? '0' : '30px')};
`;

const SideBarEnd = styled('div')`
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
`;

const IconButton = styled(IconButtonRaw)`
  aspect-ratio: 1;
  overflow: hidden;
  width: 80%;
  color: ${({ theme }) => theme.palette.action.active};
`;

export interface ProjectSessionSidebarProps extends ProjectSessionListProps {
  titleBar?: boolean;
  updaterAvailable?: boolean;
  updaterUrl?: string;
  onOpenPreferences?: () => void;
  onOpenUpdater?: (url: string) => void;
}

export const ProjectSessionSidebar: React.FC<ProjectSessionSidebarProps> = ({
  titleBar,
  updaterAvailable,
  updaterUrl,
  onOpenPreferences,
  onOpenUpdater,
  ...listProps
}) => {
  return (
    <SidebarRoot data-testid='main-sidebar'>
      <SidebarTop $titleBar={titleBar}>
        <ProjectSessionList {...listProps} />
      </SidebarTop>
      <SideBarEnd>
        {updaterAvailable && onOpenUpdater && (
          <IconButton
            id='update-available'
            onClick={() => { onOpenUpdater(updaterUrl ?? ''); }}
          >
            <Tooltip title={<span>Update Available</span>} placement='top'>
              <UpgradeIcon />
            </Tooltip>
          </IconButton>
        )}
        {onOpenPreferences && (
          <IconButton
            id='open-preferences-button'
            onClick={onOpenPreferences}
          >
            <Tooltip title={<span>Preferences</span>} placement='top'>
              <SettingsIcon />
            </Tooltip>
          </IconButton>
        )}
      </SideBarEnd>
    </SidebarRoot>
  );
};
