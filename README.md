# Agnes

Agnes 相关工作区。

## 目录结构

| 目录 | 说明 |
| --- | --- |
| `test-harness/` | 测试运行脚本（`run.mjs`） |
| `dsh-agnes-media/` | 独立仓库，插件项目，见 [dsh-agnes-media](https://github.com/) 仓库 |
| `tools/` | 本地 PortableGit 发行包，**已忽略，不纳入版本管理** |

## 使用

```bash
node test-harness/run.mjs
```

## 说明

- `tools/` 为本地工具链（约 465MB），通过 `.gitignore` 排除，不随仓库分发。
- `dsh-agnes-media/` 由独立的 Git 仓库管理，在此仓库中被忽略。
