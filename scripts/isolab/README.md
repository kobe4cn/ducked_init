# isolab：多租户边界测试租户（验收计划的 C 租户）

用法、期望与用例见 `docs/test-plans/acceptance-plan.md` 第 5 节。

```
scripts/isolab/
  setup.ts                              建上游 iso_scratch、租户 isolab 与成员、两个数据源、两个 customer 映射；--step compare 对比 B 与 C
  mappings/scratch_pg.members.customer.yaml
```

```bash
node --env-file=.env --import tsx scripts/isolab/setup.ts                              # 依赖 crm-seed 已造数
node --env-file=.env --import tsx scripts/isolab/setup.ts --step compare --with crmlab  # 手机哈希、统一消费者 ID 相同都应是 0
node --env-file=.env --import tsx scripts/isolab/setup.ts --step prepare               # 破坏性用例做完后还原上游
```
