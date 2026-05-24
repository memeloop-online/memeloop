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
} from "antd";
import { api, type Skill } from "../api";

const { Option } = Select;
const { TextArea } = Input;

const BUILTIN_TOOLS = [
  "webSearch",
  "webFetch",
  "askUserQuestion",
  "todoWrite",
  "lsp",
];

export const SkillsPage: React.FC = () => {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [form] = Form.useForm();

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await api.skills.list();
      setSkills(res.skills);
    } catch (err) {
      message.error(`Failed to load skills: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const openCreate = () => {
    setEditingSkill(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (skill: Skill) => {
    setEditingSkill(skill);
    form.setFieldsValue({
      id: skill.id,
      name: skill.name,
      instructions: skill.instructions,
      tools: skill.tools,
    });
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    Modal.confirm({
      title: "Delete Skill",
      content: "Are you sure you want to delete this skill?",
      onOk: async () => {
        try {
          await api.skills.delete(id);
          message.success("Skill deleted");
          fetchData();
        } catch (err) {
          message.error(`Failed to delete skill: ${err}`);
        }
      },
    });
  };

  const handleSave = async (values: Omit<Skill, "id"> & { id?: string }) => {
    try {
      if (editingSkill) {
        await api.skills.update(editingSkill.id, values);
        message.success("Skill updated");
      } else {
        await api.skills.create(values);
        message.success("Skill created");
      }
      setModalOpen(false);
      fetchData();
    } catch (err) {
      message.error(`Failed to save skill: ${err}`);
    }
  };

  const columns = [
    { title: "ID", dataIndex: "id", key: "id", ellipsis: true },
    { title: "Name", dataIndex: "name", key: "name" },
    {
      title: "Instructions",
      dataIndex: "instructions",
      key: "instructions",
      ellipsis: true,
    },
    {
      title: "Tools",
      dataIndex: "tools",
      key: "tools",
      render: (tools: string[]) => tools.join(", "),
    },
    {
      title: "Actions",
      key: "actions",
      render: (_: unknown, record: Skill) => (
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
          Add Skill
        </Button>
      </Space>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={skills}
        loading={loading}
      />
      <Modal
        open={modalOpen}
        title={editingSkill ? "Edit Skill" : "Add Skill"}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSave}>
          {!editingSkill && (
            <Form.Item
              name="id"
              label="ID"
              rules={[{ required: true, message: "Please enter an ID" }]}
            >
              <Input placeholder="e.g., my-skill" />
            </Form.Item>
          )}
          <Form.Item
            name="name"
            label="Name"
            rules={[{ required: true, message: "Please enter a name" }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="instructions" label="Instructions">
            <TextArea rows={4} />
          </Form.Item>
          <Form.Item name="tools" label="Tools">
            <Select mode="tags" placeholder="Select or add tools">
              {BUILTIN_TOOLS.map((t) => (
                <Option key={t} value={t}>
                  {t}
                </Option>
              ))}
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
