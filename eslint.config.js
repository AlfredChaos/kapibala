// ESLint flat config（T-P0-01）。
// 基线取向：typescript-eslint recommended + 宪法 §3-7 的两条硬规则 —— 禁 `any`、禁非受控断言。
// 不启用 type-checked 规则族：保持 lint 秒级，类型层面的保证交给 `tsc --noEmit`（pnpm typecheck）。
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // 生成物与依赖不进 lint
  { ignores: ['**/dist/', '**/coverage/', '**/node_modules/'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // 宪法 §3-7：禁止 any 与非受控断言
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // 下划线前缀 = 显式声明「有意未用」
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
