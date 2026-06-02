/**
 * PromptInput — 命令输入行
 */
import React, { useCallback, useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function PromptInput({ value, onChange, onSubmit, disabled, placeholder }: Props) {
  const handleSubmit = useCallback(
    (v: string) => {
      if (disabled) return;
      onSubmit(v);
    },
    [disabled, onSubmit],
  );

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>
          ▸{" "}
        </Text>
        {disabled ? (
          <Text dimColor>{placeholder ?? "Waiting..."}</Text>
        ) : (
          <TextInput
            value={value}
            onChange={onChange}
            onSubmit={handleSubmit}
            placeholder={placeholder}
          />
        )}
      </Box>
    </Box>
  );
}
