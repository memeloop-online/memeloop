Feature: Multi-agent coordination and lifecycle
  In order to coordinate work across specialized agents
  As a user of memeloop-cli
  I want to manage agent registries, delegate tasks, load skills, execute hooks, and checkpoint sessions

  Scenario: Agent can register and list specialized agents
    Given a memeloop node is running
    When I register a "memeloop:explore" agent
    Then the agent list should contain "memeloop:explore"

  Scenario: Task tool can spawn a sub-agent
    Given a memeloop node is running
    When I connect from "client-delegate" to the running multi-agent node via WebSocket
    When I send a task to agent "memeloop:build" with prompt "verify spawnAgent tool is registered"
    Then the task should complete successfully

  Scenario: Skill can be loaded and used by agent
    Given a memeloop node is running
    When I load skill "test-skill"
    Then the agent should use skill "test-skill"

  Scenario: Hook executes before and after tool use
    Given a memeloop node is running
    When I execute tool "file.read"
    Then hook "PostToolUse" should have been called

  Scenario: Session can be checkpointed and resumed
    Given a memeloop node is running
    When I save checkpoint "test-session"
    Then I can resume checkpoint "test-session"
