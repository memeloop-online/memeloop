import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { AgentsPage } from "./pages/AgentsPage";
import { SkillsPage } from "./pages/SkillsPage";

export const AppRoutes: React.FC = () => {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/agents" replace />} />
      <Route path="/agents" element={<AgentsPage />} />
      <Route path="/skills" element={<SkillsPage />} />
    </Routes>
  );
};
