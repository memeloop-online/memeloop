import type { AgentGoalStatus, GoalClient } from 'memeloop';

export interface GoalPanelLabels {
  title: string;
  description: string;
  objective: string;
  start: string;
  pause: string;
  resume: string;
  complete: string;
  evidence: string;
  confirmComplete: string;
  cancel: string;
  back: string;
  loading: string;
  retry: string;
  failed: string;
  runIssue: string;
  round: (round: number) => string;
  status: Record<AgentGoalStatus, string>;
}

export const defaultGoalPanelLabels: GoalPanelLabels = {
  title: 'Goal',
  description: 'The agent continues working toward this goal. You can pause and resume it here.',
  objective: 'What should the agent accomplish?',
  start: 'Start goal',
  pause: 'Pause',
  resume: 'Resume',
  complete: 'Mark complete',
  evidence: 'What confirms that this goal is complete?',
  confirmComplete: 'Complete goal',
  cancel: 'Cancel',
  back: 'Back',
  loading: 'Loading goal…',
  retry: 'Retry',
  failed: 'The goal could not be updated. Try again.',
  runIssue: 'This round needs attention. See the conversation for details.',
  round: round => `Round ${round}`,
  status: { active: 'Working', paused: 'Paused', blocked: 'Needs attention', completed: 'Completed' },
};

const simplifiedLabels: GoalPanelLabels = {
  title: '目标',
  description: '智能体会持续推进这个目标，你可以随时在这里暂停或继续。',
  objective: '你希望智能体完成什么？',
  start: '开始目标',
  pause: '暂停',
  resume: '继续',
  complete: '标记完成',
  evidence: '哪些结果可以确认目标已经完成？',
  confirmComplete: '完成目标',
  cancel: '取消',
  back: '返回',
  loading: '正在加载目标…',
  retry: '重试',
  failed: '目标更新遇到问题，请重试。',
  runIssue: '本轮执行需要处理，请查看对话中的详细信息。',
  round: round => `第 ${round} 轮`,
  status: { active: '进行中', paused: '已暂停', blocked: '需要处理', completed: '已完成' },
};

const traditionalLabels: GoalPanelLabels = {
  title: '目標',
  description: '智慧體會持續推進這個目標，你可以隨時在這裡暫停或繼續。',
  objective: '你希望智慧體完成什麼？',
  start: '開始目標',
  pause: '暫停',
  resume: '繼續',
  complete: '標記完成',
  evidence: '哪些結果可以確認目標已經完成？',
  confirmComplete: '完成目標',
  cancel: '取消',
  back: '返回',
  loading: '正在載入目標…',
  retry: '重試',
  failed: '目標更新遇到問題，請重試。',
  runIssue: '本輪執行需要處理，請查看對話中的詳細資訊。',
  round: round => `第 ${round} 輪`,
  status: { active: '進行中', paused: '已暫停', blocked: '需要處理', completed: '已完成' },
};

const japaneseLabels: GoalPanelLabels = {
  title: '目標',
  description: 'エージェントがこの目標に向けて作業を続けます。ここで一時停止や再開ができます。',
  objective: 'エージェントに何を達成してほしいですか？',
  start: '目標を開始',
  pause: '一時停止',
  resume: '再開',
  complete: '完了にする',
  evidence: '目標の達成を確認できる結果は何ですか？',
  confirmComplete: '目標を完了',
  cancel: 'キャンセル',
  back: '戻る',
  loading: '目標を読み込み中…',
  retry: '再試行',
  failed: '目標の更新を再試行してください。',
  runIssue: 'この実行には確認が必要です。会話で詳細を確認してください。',
  round: round => `${round} 回目`,
  status: { active: '作業中', paused: '一時停止中', blocked: '確認が必要', completed: '完了' },
};

export function getGoalPanelLabels(locale = 'en'): GoalPanelLabels {
  if (/^zh(?:-|_|$)/i.test(locale)) {
    return /hant|tw|hk|mo/i.test(locale) ? traditionalLabels : simplifiedLabels;
  }
  if (/^ja(?:-|_|$)/i.test(locale)) return japaneseLabels;
  return defaultGoalPanelLabels;
}

export interface GoalPanelProps {
  client: GoalClient;
  conversationId: string;
  definitionId: string;
  labels?: GoalPanelLabels;
}
