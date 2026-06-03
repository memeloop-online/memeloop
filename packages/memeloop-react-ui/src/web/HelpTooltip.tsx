import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import { IconButton, Tooltip } from "@mui/material";
import React from "react";

export interface HelpTooltipProps {
  title: React.ReactNode;
  /** 与 RJSF label 并排时的 aria 标签 */
  "aria-label"?: string;
}

/** 表单字段旁的帮助提示，供自定义 FieldTemplate / widgets 使用。 */
export function HelpTooltip(props: HelpTooltipProps): React.ReactElement {
  const { title, ...rest } = props;
  return (
    <Tooltip title={title}>
      <IconButton size="small" edge="end" {...rest}>
        <HelpOutlineIcon fontSize="inherit" />
      </IconButton>
    </Tooltip>
  );
}
