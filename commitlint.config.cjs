module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // 提交类型白名单：必须使用约定式提交的常见 type
    'type-enum': [2, 'always', ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']],
    // type 不允许为空，例如不允许 ": xxx"
    'type-empty': [2, 'never'],
    // subject 不允许为空，例如不允许 "feat:"
    'subject-empty': [2, 'never'],
    // 提交标题最大长度限制，避免过长影响可读性
    'header-max-length': [2, 'always', 100],
  },
}
