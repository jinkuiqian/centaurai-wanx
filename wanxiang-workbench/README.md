# @wanxiang/workbench

万象工作台的产品 Bundle，把以下能力组合进同一个原生应用：

- 用对话形成真实工作简报，并在右侧实时整理结果。
- 确认简报后原位进入构建与验证会话。
- 通过 `wanxiang_generate_work_agent` 从当前确认的工作说明生成项目专属 Agent、输入/输出契约和冒烟 Eval，再由 `wanxiang_run_evaluation` 在 DSH Workflow Worker 中执行确定性运行。
- Agent、Workflow、Eval 与运行证据记录同一工作说明修订和版本链；生成的 Workflow 默认无网络和外部副作用，客户跟进五案例只保留为回归夹具。
- 在侧栏随时切换需求发现，自由工作台不会被锁成线性向导。
- 统一万象品牌、浏览器标题、应用清单和图标。
- 保留社群咨询抽屉，但不让社群进入 Agent 流程。
- 隐藏面向框架开发者的插件清单与测试插件配置。

启动器会把 `cordis.patch.yml` 中的入口占位符渲染成当前安装位置的绝对路径，因此产品不依赖任何本机源码仓库。
