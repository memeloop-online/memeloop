/**
 * Task category system for routing tasks to appropriate agent configurations.
 * Each category maps to a model, temperature, and description for delegation decisions.
 */

export type TaskCategory =
  | 'visual-engineering'
  | 'ultrabrain'
  | 'artistry'
  | 'quick'
  | 'unspecified-low'
  | 'unspecified-high'
  | 'writing';

export interface CategoryConfig {
  /** Model identifier (e.g., "default", "gpt-4o", "claude-opus") */
  model: string;
  /** LLM temperature (0.0 = deterministic, 1.0 = creative) */
  temperature: number;
  /** Human-readable description of the category's purpose */
  description: string;
}

const CATEGORY_CONFIGS: Record<TaskCategory, CategoryConfig> = {
  'visual-engineering': {
    model: 'default',
    temperature: 0.3,
    description: 'UI/UX visual engineering tasks requiring precise rendering and layout',
  },
  ultrabrain: {
    model: 'default',
    temperature: 0.1,
    description: 'Deep logical reasoning, architecture decisions, and complex problem-solving',
  },
  artistry: {
    model: 'default',
    temperature: 0.8,
    description: 'Creative writing, design, and artistic generation tasks',
  },
  quick: {
    model: 'default',
    temperature: 0.2,
    description: 'Fast, straightforward tasks with minimal deliberation needed',
  },
  'unspecified-low': {
    model: 'default',
    temperature: 0.5,
    description: 'Unclassified tasks of moderate complexity and effort',
  },
  'unspecified-high': {
    model: 'default',
    temperature: 0.4,
    description: 'Unclassified tasks requiring substantial effort across multiple systems',
  },
  writing: {
    model: 'default',
    temperature: 0.7,
    description: 'Documentation, prose, technical writing, and content generation',
  },
};

/**
 * Get the configuration for a task category.
 * @throws {Error} if the category is unknown
 */
export function getCategoryConfig(category: TaskCategory): CategoryConfig {
  const config = CATEGORY_CONFIGS[category];
  if (!config) {
    throw new Error(`Unknown task category: ${category}`);
  }
  return { ...config };
}

/**
 * Type guard: check if a string is a valid TaskCategory.
 */
export function isTaskCategory(value: string): value is TaskCategory {
  return value in CATEGORY_CONFIGS;
}

/** All registered category identifiers (read-only). */
export const ALL_CATEGORIES = Object.keys(CATEGORY_CONFIGS) as TaskCategory[];

/**
 * Resolve a category string (or fallback to "unspecified-low").
 * Never throws; always returns a valid config.
 */
export function resolveCategory(category: string): CategoryConfig {
  if (isTaskCategory(category)) {
    return getCategoryConfig(category);
  }
  return getCategoryConfig('unspecified-low');
}
