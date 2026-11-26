import SettingsIcon from '@mui/icons-material/Settings';
import UpgradeIcon from '@mui/icons-material/Upgrade';
import { IconButton as IconButtonRaw, Tooltip } from '@mui/material';
import { styled } from '@mui/material/styles';
import React from 'react';
import { ProjectSessionList, type ProjectSessionListProps } from '../ProjectSessionList';

const SidebarRoot = styled('div')<{ $sidebarWidth: number }>`
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
  width: ${({ $sidebarWidth }) => $sidebarWidth}px;
  max-width: 100%;
  min-width: 0;
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
  /** Preferred sidebar width. The component shrinks when hosted in a narrower surface. */
  sidebarWidth?: number;
  titleBar?: boolean;
  updaterAvailable?: boolean;
  updaterUrl?: string;
  onOpenPreferences?: () => void;
  onOpenUpdater?: (url: string) => void;
  labels?: Partial<ProjectSessionSidebarLabels>;
}

export interface ProjectSessionSidebarLabels {
  updateAvailable: string;
  preferences: string;
}

const defaultLabels: ProjectSessionSidebarLabels = {
  updateAvailable: 'Update Available',
  preferences: 'Preferences',
};

export const ProjectSessionSidebar: React.FC<ProjectSessionSidebarProps> = ({
  titleBar,
  updaterAvailable,
  updaterUrl,
  onOpenPreferences,
  onOpenUpdater,
  labels: labelOverrides,
  sidebarWidth = 200,
  ...listProps
}) => {
  const labels = { ...defaultLabels, ...labelOverrides };
  return (
    <SidebarRoot data-testid='main-sidebar' $sidebarWidth={sidebarWidth}>
      <SidebarTop $titleBar={titleBar}>
        <ProjectSessionList {...listProps} />
      </SidebarTop>
      <SideBarEnd>
        {updaterAvailable && onOpenUpdater && (
          <IconButton
            id='update-available'
            onClick={() => {
              onOpenUpdater(updaterUrl ?? '');
            }}
          >
            <Tooltip title={<span>{labels.updateAvailable}</span>} placement='top'>
              <UpgradeIcon />
            </Tooltip>
          </IconButton>
        )}
        {onOpenPreferences && (
          <IconButton id='open-preferences-button' onClick={onOpenPreferences}>
            <Tooltip title={<span>{labels.preferences}</span>} placement='top'>
              <SettingsIcon />
            </Tooltip>
          </IconButton>
        )}
      </SideBarEnd>
    </SidebarRoot>
  );
};
