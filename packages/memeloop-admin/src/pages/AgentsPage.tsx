import React, { useEffect, useState } from "react";
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  Space,
  message,
  Tag,
} from "antd";
import { api, type Agent, type Skill } from "../api";

const { Option } = Select;
const { TextArea } = Input;

const AGENT_TYPES: Agent["type"][] = ["build", "plan", "explore", "oracle", "librarian"];

export const AgentsPage: React.FC = () => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [form] = Form.useForm();

  const fetchData = async () => {
    setLoading(true);
    try {
      const [agentsRes, skillsRes] = await Promise.all([
        api.agents.list(),
        api.skills.list(),
      ]);
      setAgents(agentsRes.agents);
      setSkills(skillsRes.skills);
    } catch (err) {
      message.error(`Failed to load data: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const openCreate = () => {
    setEditingAgent(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (agent: Agent) => {
    setEditingAgent(agent);
    form.setFieldsValue({
      name: agent.name,
      type: agent.type,
      description: agent.description,
      skills: agent.skills,
      prompt: agent.prompt,
    });
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    Modal.confirm({
      title: "Delete Agent",
      content: "Are you sure you want to delete this agent?",
      onOk: async () => {
        try {
          await api.agents.delete(id);
          message.success("Agent deleted");
          fetchData();
        } catch (err) {
          message.error(`Failed to delete agent: ${err}`);
        }
      },
    });
  };

  const handleSave = async (values: Omit<Agent, "id">) => {
    try {
      if (editingAgent) {
        await api.agents.update(editingAgent.id, values);
        message.success("Agent updated");
      } else {
        await api.agents.create(values);
        message.success("Agent created");
      }
      setModalOpen(false);
      fetchData();
    } catch (err) {
      message.error(`Failed to save agent: ${err}`);
    }
  };

  const columns = [
    { title: "Name", dataIndex: "name", key: "name" },
    { title: "Type", dataIndex: "type", key: "type" },
    {
      title: "Description",
      dataIndex: "description",
      key: "description",
      ellipsis: true,
    },
    {
      title: "Skills",
      dataIndex: "skills",
      key: "skills",
      render: (skills: string[]) => (
        <Space size="small" wrap>
          {skills.map((s) => (
            <Tag key={s}>{s}</Tag>
          ))}
        </Space>
      ),
    },
    {
      title: "Actions",
      key: "actions",
      render: (_: unknown, record: Agent) => (
        <Space>
          <Button size="small" onClick={() => openEdit(record)}>
            Edit
          </Button>
          <Button size="small" danger onClick={() => handleDelete(record.id)}>
            Delete
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={openCreate}>
          Add Agent
        </Button>
      </Space>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={agents}
        loading={loading}
      />
      <Modal
        open={modalOpen}
        title={editingAgent ? "Edit Agent" : "Add Agent"}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item
            name="name"
            label="Name"
            rules={[{ required: true, message: "Please enter a name" }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="type"
            label="Type"
            rules={[{ required: true, message: "Please select a type" }]}
          >
            <Select placeholder="Select agent type">
              {AGENT_TYPES.map((t) => (
                <Option key={t} value={t}>
                  {t}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="description" label="Description">
            <TextArea rows={3} />
          </Form.Item>
          <Form.Item name="skills" label="Skills">
            <Select mode="multiple" placeholder="Select skills">
              {skills.map((s) => (
                <Option key={s.id} value={s.id}>
                  {s.name}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="prompt" label="Prompt">
            <TextArea rows={4} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
