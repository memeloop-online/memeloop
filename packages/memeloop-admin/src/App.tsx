import React from "react";
import { Link, useLocation } from "react-router-dom";
import { Layout, Menu, Typography } from "antd";
import { AppRoutes } from "./routes";

const { Header, Sider, Content } = Layout;

export const App: React.FC = () => {
  const location = useLocation();

  const menuItems = [
    { key: "/agents", label: <Link to="/agents">Agents</Link> },
    { key: "/skills", label: <Link to="/skills">Skills</Link> },
  ];

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Header style={{ display: "flex", alignItems: "center", background: "#001529" }}>
        <Typography.Title level={4} style={{ color: "#fff", margin: 0 }}>
          MemeLoop Admin
        </Typography.Title>
      </Header>
      <Layout>
        <Sider theme="dark" width={200}>
          <Menu
            mode="inline"
            theme="dark"
            selectedKeys={[location.pathname]}
            items={menuItems}
            style={{ height: "100%" }}
          />
        </Sider>
        <Content style={{ padding: 24, background: "#f0f2f5" }}>
          <AppRoutes />
        </Content>
      </Layout>
    </Layout>
  );
};
