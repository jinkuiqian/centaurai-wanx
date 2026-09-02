window.__ModuleLoader__.load({
  id: "@wanxiang/workbench",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const h = React.createElement;

    const DRAFT_PREFIX = "wanxiang-workbench-v3:draft:";
    const CHANNEL_NAME = "wanxiang-workbench-v3";
    const MODULE_GENERATION = Symbol("wanxiang-workbench-v3");
    window.__WANXIANG_WORKBENCH_GENERATION__ = MODULE_GENERATION;

    const fields = [
      { key: "goal", label: "目标", required: true, placeholder: "这项工作最终要解决什么真实问题？" },
      { key: "inputs", label: "真实输入", required: true, placeholder: "会用到哪些文件、网页、数据或既有资料？" },
      { key: "examples", label: "代表案例", required: false, placeholder: "可补充一个过去做对的案例；留空时将在制作中验证。" },
      { key: "rules", label: "规则", required: false, placeholder: "有哪些判断方法或必须遵守的业务规则？" },
      { key: "output", label: "交付物", required: true, placeholder: "最终交付什么、以什么格式、给谁使用？" },
      { key: "boundaries", label: "边界", required: false, placeholder: "哪些事情不能自动做，何时必须由你确认？" },
      { key: "success", label: "验收标准", required: true, placeholder: "在真实材料上怎样判断结果可以使用？" },
    ];
    const requiredKeys = fields.filter((field) => field.required).map((field) => field.key);
    const fieldKeys = new Set(fields.map((field) => field.key));
    const fieldByKey = Object.fromEntries(fields.map((field) => [field.key, field]));
    const sourceLabels = { user_confirmed: "用户确认", inferred: "根据案例推断", unresolved: "待确认" };
    const proxyRunCaseLabels = {
      "customer-follow-up-normal-v1": "正常客户",
      "customer-follow-up-overdue-v1": "超过 14 天未跟进",
      "customer-follow-up-no-communication-v1": "无沟通记录",
      "customer-follow-up-high-intent-no-next-step-v1": "高意向但无下一步",
      "customer-follow-up-missing-owner-v1": "缺少负责人",
    };
    const guidanceQuestions = {
      goal: "这项工作现在怎么做，最想解决哪个具体问题？",
      inputs: "可以提供一份真实材料，或说明资料来自哪里吗？",
      output: "最终需要交付什么、以什么格式、给谁使用？",
      success: "拿真实材料运行后，怎样才算可以使用？",
    };
    const guidanceExamples = [
      { label: "整理客户周报", draft: "我每周都要把客户沟通记录整理成周报。我可以提供一份真实记录和过去写得好的周报，请帮我把这项工作做得稳定可复用。" },
      { label: "核对表格并生成清单", draft: "我经常需要核对一份业务表格并生成待处理清单。我可以提供真实表格，请先和我确认核对规则、输出格式与验收标准。" },
      { label: "研究资料形成简报", draft: "我需要定期研究公开资料并形成简报。我可以给你一个真实主题和参考简报，请先理解读者、资料范围与什么样的结果才算可用。" },
    ];
    const listeners = new Set();
    const records = new Map();
    let overlay = null;
    let rootContext;
    let channel;

    function emit() { for (const listener of listeners) listener(); }
    function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    function assertGeneration() {
      if (window.__WANXIANG_WORKBENCH_GENERATION__ !== MODULE_GENERATION) throw new Error("万象刚刚完成更新，请重试当前操作。");
    }
    function answerObject(source, key = "answers") {
      const answerSource = source?.brief?.[key] || source?.[key] || {};
      return Object.fromEntries(fields.map(({ key: fieldKey }) => {
        const raw = Array.isArray(answerSource[fieldKey]) ? answerSource[fieldKey].join("、") : answerSource[fieldKey];
        return [fieldKey, String(raw || "").trim()];
      }));
    }
    function isPlaceholderAnswer(value) {
      const text = String(value || "").trim();
      return !text || /^(?:待在.+继续确认|待补充|待填写|待确认|未填写|todo|n\/a)$/iu.test(text);
    }
    function fieldSourceObject(source, answers, key = "fieldSources") {
      const raw = source?.brief?.[key] || source?.[key] || {};
      return Object.fromEntries(fields.map(({ key: fieldKey }) => {
        const value = raw[fieldKey];
        const status = ["user_confirmed", "inferred", "unresolved"].includes(value?.status)
          ? value.status : !isPlaceholderAnswer(answers[fieldKey]) ? "user_confirmed" : "unresolved";
        return [fieldKey, {
          status,
          sourceMessageIds: Array.isArray(value?.sourceMessageIds)
            ? value.sourceMessageIds.filter((item) => typeof item === "string") : [],
        }];
      }));
    }
    function deriveGuidance(project) {
      const known = (key) => !isPlaceholderAnswer(project.answers[key]);
      const confirmed = (key) => known(key) && project.fieldSources[key]?.status === "user_confirmed";
      const progress = {
        requiredKnown: requiredKeys.filter(known).length,
        requiredConfirmed: requiredKeys.filter(confirmed).length,
        requiredTotal: requiredKeys.length,
        allKnown: fields.filter(({ key }) => known(key)).length,
        allTotal: fields.length,
      };
      const deferredFields = fields.filter((field) => !field.required && (!known(field.key)
        || project.fieldSources[field.key]?.status === "unresolved")).map(({ key }) => key);
      const activation = project.work.activation;
      const result = (stage, kind, field, prompt) => ({ stage, progress, deferredFields, next: { kind, field, prompt } });
      if (activation?.status === "pending") return result("activating", "activation_pending", null, "万象正在安全切换到制作状态，请等待当前操作完成。");
      if (activation?.status === "failed" && activation.briefRevision === project.briefRevision) return result("failed", "retry_activation", null, "上次开始制作没有完成，请检查失败原因后重试。");
      if (Number.isInteger(project.work.activeRevision) && project.briefRevision > project.work.activeRevision) return result("changed", "sync_changes", null, "工作说明已有修改，请确认同步后继续制作。");
      if (Number.isInteger(project.work.activeRevision) && project.work.activeRevision === project.briefRevision) return result("making", "continue_making", null, "工作说明已经生效，请继续制作并用真实材料验证。");
      const nextField = requiredKeys.find((key) => !known(key));
      if (nextField) return result("understanding", "ask_field", nextField, guidanceQuestions[nextField]);
      if (requiredKeys.some((key) => !confirmed(key))) return result("reviewing", "review_and_confirm", null, "请打开工作说明，核对制作前的四项关键内容；有误直接修改，确认无误后再开始制作。");
      return result("ready", "start_making", null, "工作说明已经确认，可以在当前对话中开始制作。");
    }
    function normalizeGuidance(raw, fallback) {
      if (!raw || typeof raw !== "object") return fallback;
      const progress = raw.progress && typeof raw.progress === "object" ? raw.progress : {};
      const count = (value, fallbackValue) => Number.isInteger(value) && value >= 0 ? value : fallbackValue;
      const next = raw.next && typeof raw.next === "object" ? raw.next : fallback.next;
      return {
        stage: typeof raw.stage === "string" ? raw.stage : fallback.stage,
        progress: {
          requiredKnown: count(progress.requiredKnown, fallback.progress.requiredKnown),
          requiredConfirmed: count(progress.requiredConfirmed, fallback.progress.requiredConfirmed),
          requiredTotal: count(progress.requiredTotal, fallback.progress.requiredTotal),
          allKnown: count(progress.allKnown, fallback.progress.allKnown),
          allTotal: count(progress.allTotal, fallback.progress.allTotal),
        },
        deferredFields: Array.isArray(raw.deferredFields)
          ? raw.deferredFields.filter((key) => fieldKeys.has(key)) : fallback.deferredFields,
        next: {
          kind: typeof next?.kind === "string" ? next.kind : fallback.next.kind,
          field: fieldKeys.has(next?.field) ? next.field : null,
          prompt: typeof next?.prompt === "string" && next.prompt.trim() ? next.prompt : fallback.next.prompt,
        },
      };
    }
    function deriveProjection(project) {
      const missingRequired = requiredKeys.filter((key) => isPlaceholderAnswer(project.answers[key]));
      const unresolvedOptional = fields
        .filter((field) => !field.required && project.fieldSources[field.key]?.status === "unresolved")
        .map((field) => field.key);
      const activation = project.work.activation;
      let phase = "understanding";
      if (activation?.status === "failed") phase = "failed";
      else if (Number.isInteger(project.work.activeRevision) && project.briefRevision > project.work.activeRevision) phase = "changed";
      else if (Number.isInteger(project.work.activeRevision)) phase = "making";
      else if (missingRequired.length === 0) phase = "ready";
      return { phase, readiness: { ready: missingRequired.length === 0, missingRequired, unresolvedOptional }, guidance: deriveGuidance(project) };
    }
    function normalizeEvaluation(value) {
      const source = value && typeof value === "object" ? value : {};
      return {
        workflowVersion: typeof source.workflowVersion === "string" ? source.workflowVersion : null,
        evalRevision: Number.isInteger(source.evalRevision) ? source.evalRevision : null,
        cases: Array.isArray(source.cases) ? source.cases.filter((item) => item && typeof item.id === "string").map((item) => ({
          id: item.id,
          title: typeof item.title === "string" && item.title ? item.title : proxyRunCaseLabels[item.id] || item.id,
          kind: item.kind === "boundary" ? "boundary" : "normal",
        })) : [],
      };
    }
    function normalizeRuns(value) {
      const source = value && typeof value === "object" ? value : {};
      const rawById = source.byId && typeof source.byId === "object" ? source.byId : {};
      const order = Array.isArray(source.order) ? source.order.filter((runId) => typeof runId === "string" && rawById[runId]) : [];
      return {
        latestRunId: typeof source.latestRunId === "string" ? source.latestRunId : null,
        order,
        byId: Object.fromEntries(order.map((runId) => [runId, rawById[runId]])),
      };
    }
    function emptyProject(workspaceId) {
      const answers = Object.fromEntries(fields.map(({ key }) => [key, ""]));
      const fieldSources = Object.fromEntries(fields.map(({ key }) => [key, { status: "unresolved", sourceMessageIds: [] }]));
      const project = {
        workspaceId,
        schemaVersion: 2,
        baseVersion: 0,
        projectName: "我的工作项目",
        answers,
        fieldSources,
        confirmedAnswers: null,
        confirmedFieldSources: null,
        briefRevision: 0,
        confirmedRevision: null,
        work: { sessionId: null, activeRevision: null, activation: null },
        evaluation: normalizeEvaluation(null),
        runs: normalizeRuns(null),
      };
      return { ...project, ...deriveProjection(project) };
    }
    function normalizeProject(value, workspaceId) {
      const source = value?.state && typeof value.state === "object"
        ? value.state : value?.project && typeof value.project === "object" ? value.project : value || {};
      const projection = value?.projection && typeof value.projection === "object" ? value.projection : source;
      const answers = answerObject(source);
      const fieldSources = fieldSourceObject(source, answers);
      const confirmedRaw = source?.brief?.confirmedAnswers || source?.confirmedAnswers;
      const confirmedAnswers = confirmedRaw ? answerObject(source, "confirmedAnswers") : null;
      const confirmedFieldSources = confirmedAnswers
        ? fieldSourceObject(source, confirmedAnswers, "confirmedFieldSources") : null;
      const legacyDispatch = source.builder?.lastDispatch;
      const workSource = source.work && typeof source.work === "object" ? source.work : {};
      const activationSource = workSource.activation && typeof workSource.activation === "object"
        ? workSource.activation : legacyDispatch ? {
          id: legacyDispatch.id,
          briefRevision: legacyDispatch.briefRevision,
          sessionId: source.builder?.sessionId || legacyDispatch.builderSessionId,
          status: legacyDispatch.status === "sent" ? "active" : legacyDispatch.status === "failed" ? "failed" : "pending",
          messageId: legacyDispatch.messageId || null,
          error: legacyDispatch.error || null,
          createdAt: legacyDispatch.createdAt,
          updatedAt: legacyDispatch.updatedAt,
        } : null;
      const project = {
        ...source,
        workspaceId: String(source.workspaceId || workspaceId),
        schemaVersion: Number.isInteger(source.schemaVersion) ? source.schemaVersion : 2,
        baseVersion: Number.isInteger(source.stateVersion)
          ? source.stateVersion : Number.isInteger(source.baseVersion) ? source.baseVersion : 0,
        projectName: String(source.projectName || "我的工作项目").trim() || "我的工作项目",
        answers,
        fieldSources,
        confirmedAnswers,
        confirmedFieldSources,
        briefRevision: Number.isInteger(source.brief?.revision)
          ? source.brief.revision : Number.isInteger(source.briefRevision) ? source.briefRevision : 0,
        confirmedRevision: Number.isInteger(source.brief?.confirmedRevision)
          ? source.brief.confirmedRevision : Number.isInteger(source.confirmedRevision) ? source.confirmedRevision : null,
        work: {
          sessionId: typeof workSource.sessionId === "string" ? workSource.sessionId : source.builder?.sessionId || null,
          activeRevision: Number.isInteger(workSource.activeRevision)
            ? workSource.activeRevision
            : legacyDispatch?.status === "sent" && Number.isInteger(legacyDispatch.briefRevision) ? legacyDispatch.briefRevision : null,
          activation: activationSource,
        },
        evaluation: normalizeEvaluation(value?.evaluation || source.evaluation || records.get(workspaceId)?.project?.evaluation),
        runs: normalizeRuns(source.runs),
      };
      const derived = deriveProjection(project);
      return {
        ...project,
        phase: ["understanding", "ready", "making", "changed", "failed"].includes(projection?.phase)
          ? projection.phase : derived.phase,
        readiness: projection?.readiness && typeof projection.readiness === "object" ? {
          ready: projection.readiness.ready === true,
          missingRequired: Array.isArray(projection.readiness.missingRequired)
            ? projection.readiness.missingRequired : derived.readiness.missingRequired,
          unresolvedOptional: Array.isArray(projection.readiness.unresolvedOptional)
            ? projection.readiness.unresolvedOptional : derived.readiness.unresolvedOptional,
        } : derived.readiness,
        guidance: normalizeGuidance(projection?.guidance, derived.guidance),
      };
    }
    function readDraft(workspaceId) {
      try {
        const value = JSON.parse(localStorage.getItem(`${DRAFT_PREFIX}${workspaceId}`) || "null");
        if (value && typeof value === "object") return {
          projectName: typeof value.projectName === "string" ? value.projectName : undefined,
          answers: value.answers && typeof value.answers === "object" ? value.answers : {},
        };
      } catch {}
      return { answers: {} };
    }
    function writeDraft(workspaceId, draft) {
      try {
        const answers = Object.fromEntries(Object.entries(draft.answers || {})
          .filter(([key, value]) => fieldKeys.has(key) && typeof value === "string"));
        const value = { answers };
        if (typeof draft.projectName === "string") value.projectName = draft.projectName;
        if (value.projectName === undefined && Object.keys(answers).length === 0) localStorage.removeItem(`${DRAFT_PREFIX}${workspaceId}`);
        else localStorage.setItem(`${DRAFT_PREFIX}${workspaceId}`, JSON.stringify(value));
      } catch {}
    }
    function recoverLegacy(workspaceId, draft) {
      if (draft.projectName !== undefined || Object.keys(draft.answers).length) return draft;
      for (const key of ["wanxiang-workbench-v2:draft:", "wanxiang-workbench-v1", "wanxiang-prototype-v5"]) {
        try {
          const storageKey = key.endsWith(":") ? `${key}${workspaceId}` : key;
          const value = JSON.parse(localStorage.getItem(storageKey) || "null");
          const oldAnswers = value?.answers || value?.discoveryDraft;
          if (!oldAnswers && !value?.projectName) continue;
          const recovered = { projectName: value.projectName, answers: {} };
          for (const { key: fieldKey } of fields) if (typeof oldAnswers?.[fieldKey] === "string") recovered.answers[fieldKey] = oldAnswers[fieldKey];
          writeDraft(workspaceId, recovered);
          return recovered;
        } catch {}
      }
      return draft;
    }
    function recordFor(workspaceId) {
      if (!records.has(workspaceId)) records.set(workspaceId, {
        workspaceId,
        status: "idle",
        project: emptyProject(workspaceId),
        draft: recoverLegacy(workspaceId, readDraft(workspaceId)),
        error: "",
        errorCode: "",
        conflict: false,
        busy: false,
      });
      return records.get(workspaceId);
    }
    function replaceRecord(workspaceId, patch) {
      const next = { ...recordFor(workspaceId), ...patch };
      records.set(workspaceId, next);
      emit();
      return next;
    }
    function setDraft(workspaceId, patch) {
      const current = recordFor(workspaceId).draft;
      const draft = { ...current, ...patch, answers: patch.answers ? { ...current.answers, ...patch.answers } : current.answers };
      writeDraft(workspaceId, draft);
      replaceRecord(workspaceId, { draft });
    }
    function clearDraft(workspaceId, key) {
      const current = recordFor(workspaceId).draft;
      const draft = { ...current, answers: { ...current.answers } };
      if (key === "projectName") delete draft.projectName;
      else delete draft.answers[key];
      writeDraft(workspaceId, draft);
      replaceRecord(workspaceId, { draft });
    }
    function useRecord(workspaceId) {
      return React.useSyncExternalStore(subscribe, () => workspaceId ? recordFor(workspaceId) : null, () => workspaceId ? recordFor(workspaceId) : null);
    }
    async function apiJson(url, options) {
      const response = await fetch(url, { credentials: "same-origin", ...options });
      let body = null;
      try { body = await response.json(); } catch {}
      if (!response.ok) {
        const error = new Error(body?.message || (response.status === 409
          ? "这份工作说明已在别处更新，已为你载入最新版本。"
          : "万象服务暂时不可用，请稍后重试。"));
        error.status = response.status;
        error.code = typeof body?.code === "string" ? body.code : "request_failed";
        error.current = body?.current || body?.state;
        throw error;
      }
      return body;
    }
    async function loadProject(workspaceId, quiet = false) {
      const prior = recordFor(workspaceId);
      if (!quiet) replaceRecord(workspaceId, { status: "loading", error: "", errorCode: "" });
      try {
        const body = await apiJson(`/api/wanxiang/project?workspaceId=${encodeURIComponent(workspaceId)}`);
        assertGeneration();
        replaceRecord(workspaceId, { status: "ready", project: normalizeProject(body, workspaceId), error: "", errorCode: "", conflict: false });
      } catch (error) {
        replaceRecord(workspaceId, { status: prior.status === "ready" ? "ready" : "error", error: error.message, errorCode: error.code });
      }
    }
    function ensureProject(workspaceId) { if (recordFor(workspaceId).status === "idle") void loadProject(workspaceId); }
    function broadcast(workspaceId) { try { channel?.postMessage({ workspaceId }); } catch {} }
    async function putProject(workspaceId, patch, clearedKey) {
      const record = recordFor(workspaceId);
      replaceRecord(workspaceId, { busy: true, error: "", errorCode: "", conflict: false });
      try {
        const body = await apiJson("/api/wanxiang/project", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId, baseVersion: record.project.baseVersion, patch }),
        });
        assertGeneration();
        clearDraft(workspaceId, clearedKey);
        replaceRecord(workspaceId, { busy: false, status: "ready", project: normalizeProject(body, workspaceId), error: "", errorCode: "", conflict: false });
        broadcast(workspaceId);
      } catch (error) {
        if (error.status === 409) {
          replaceRecord(workspaceId, { busy: false, conflict: true, error: error.message, errorCode: error.code });
          await loadProject(workspaceId, true);
          replaceRecord(workspaceId, { conflict: true, error: error.message, errorCode: error.code });
        } else replaceRecord(workspaceId, { busy: false, error: error.message, errorCode: error.code });
        throw error;
      }
    }
    async function importWorkspace(workspaceId) {
      replaceRecord(workspaceId, { busy: true, error: "" });
      try {
        const body = await apiJson("/api/wanxiang/projects", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }),
        });
        assertGeneration();
        replaceRecord(workspaceId, { status: "ready", busy: false, project: normalizeProject(body, workspaceId), error: "", errorCode: "", conflict: false });
        broadcast(workspaceId);
      } catch (error) {
        replaceRecord(workspaceId, { status: "error", busy: false, error: error.message, errorCode: error.code });
      }
    }

    function workspaceForSession(ctx, sessionId) {
      const workspaces = ctx.workspaces.list.getSnapshot();
      const summary = ctx.sessions.list.getSnapshot().byId[sessionId];
      return workspaces.items.find((item) => item.sessionIds.includes(sessionId))
        || workspaces.items.find((item) => summary?.cwd && item.path === summary.cwd);
    }
    function useWorkspace(sessionId) {
      const [workspace, setWorkspace] = React.useState(() => workspaceForSession(rootContext, sessionId));
      React.useEffect(() => {
        const update = () => setWorkspace(workspaceForSession(rootContext, sessionId));
        const disposeWorkspaces = rootContext.workspaces.list.subscribe(update);
        const disposeSessions = rootContext.sessions.list.subscribe(update);
        update();
        return () => { disposeWorkspaces(); disposeSessions(); };
      }, [sessionId]);
      React.useEffect(() => { if (workspace) ensureProject(workspace.workspaceId); }, [workspace?.workspaceId]);
      return workspace;
    }
    function openOverlay(kind, sessionId, trigger = document.activeElement) { overlay = { kind, sessionId, trigger }; emit(); }
    function closeOverlay() { overlay = null; emit(); }
    function useOverlay() { return React.useSyncExternalStore(subscribe, () => overlay, () => null); }

    function installProductTitle(ctx) {
      let frame = 0;
      let timer = 0;
      const sync = () => {
        cancelAnimationFrame(frame);
        clearTimeout(timer);
        frame = requestAnimationFrame(() => {
          timer = window.setTimeout(() => { document.title = "万象"; }, 0);
        });
      };
      const dispose = ctx.sessions.list.subscribe(sync);
      sync();
      return () => { dispose(); cancelAnimationFrame(frame); clearTimeout(timer); };
    }

    function Icon({ name, size = 18 }) {
      const paths = {
        brief: "M5 3.5h9a2 2 0 0 1 2 2v13H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Zm1 4h7M6 11h7M6 14.5h5",
        community: "M7.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm5.5-1a2.5 2.5 0 1 0 0-5M2.5 17c.4-3 2-4.5 5-4.5s4.6 1.5 5 4.5M12 12c3.2 0 4.8 1.5 5.2 4.5",
        close: "m5 5 10 10M15 5 5 15",
        check: "m4 10 4 4 8-9",
      };
      return h("svg", { viewBox: "0 0 20 20", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" }, h("path", { d: paths[name] || paths.brief }));
    }
    function Mark({ size = 24, className }) {
      return h("span", { className: `wx-mark ${className || ""}`.trim(), "aria-hidden": "true", style: { width: size, height: size, fontSize: Math.max(10, size * .42) } }, "万");
    }
    function Name() { return h("span", { className: "wx-brand" }, "万象"); }
    function guidanceTone(stage) {
      if (["failed", "changed"].includes(stage)) return "problem";
      if (["making", "activating"].includes(stage)) return "active";
      if (["reviewing", "ready"].includes(stage)) return "attention";
      return "quiet";
    }
    function guidanceTitle(stage) {
      const titles = {
        understanding: "先把真实工作说清楚",
        reviewing: "制作条件已经齐备",
        ready: "可以开始制作",
        activating: "正在准备制作",
        making: "正在制作与验证",
        changed: "工作说明有新修改",
        failed: "上次制作没有启动",
      };
      return titles[stage] || titles.understanding;
    }
    function canonicalSessionElsewhere(project, sessionId) {
      return Boolean(project?.work?.sessionId
        && project.work.sessionId !== sessionId
        && Number.isInteger(project.work.activeRevision));
    }
    function guidanceActionLabel(guidance, project, sessionId) {
      if (canonicalSessionElsewhere(project, sessionId)) return "返回制作会话";
      const labels = {
        review_and_confirm: "确认工作说明并开始制作",
        start_making: "确认并开始制作",
        activation_pending: "查看准备状态",
        continue_making: "查看制作说明",
        sync_changes: "确认修改并继续",
        retry_activation: "查看原因并重试",
      };
      if (guidance.next.kind === "ask_field") return `补充${fieldByKey[guidance.next.field]?.label || "关键信息"}`;
      return labels[guidance.next.kind] || "打开工作说明";
    }
    function GuidanceProgress({ guidance, answers }) {
      const progress = guidance.progress;
      return h("div", { className: "wx-guidance-progress", "aria-label": `制作条件 ${progress.requiredKnown}/${progress.requiredTotal}，工作说明 ${progress.allKnown}/${progress.allTotal}` },
        h("span", null, "制作条件 ", h("strong", null, `${progress.requiredKnown}/${progress.requiredTotal}`)),
        h("span", null, "工作说明 ", h("strong", null, `${progress.allKnown}/${progress.allTotal}`)),
        h("div", { className: "wx-guidance-meter", "aria-hidden": "true" }, fields.map((field) => h("i", {
          key: field.key,
          "data-known": !isPlaceholderAnswer(answers?.[field.key]) || undefined,
          "data-required": field.required || undefined,
        }))));
    }
    function GuidanceDock({ session, sessionId, input, inputActions }) {
      const id = sessionId || session.sessionId;
      const workspace = useWorkspace(id);
      const record = useRecord(workspace?.workspaceId);
      const project = record?.project;
      const guidance = project?.guidance || deriveGuidance(emptyProject(workspace?.workspaceId || ""));
      const stage = guidance.stage;
      const isEmpty = Boolean(session.blank) && guidance.progress.allKnown === 0;
      const firstTurnPending = Boolean(session.promptAttempted || session.awaitingFirstTurn);
      const [collapsed, setCollapsed] = React.useState(false);
      const [prefilled, setPrefilled] = React.useState(false);
      const [model, setModel] = React.useState("checking");
      const guidanceContentId = React.useId();
      const draftText = typeof input?.draft === "string" ? input.draft : "";
      const canPrefill = !firstTurnPending && !draftText.trim() && typeof inputActions?.setDraft === "function";
      React.useEffect(() => {
        setCollapsed(["making", "activating"].includes(stage));
        setPrefilled(false);
        setModel("checking");
      }, [id]);
      React.useEffect(() => {
        if (["making", "activating"].includes(stage)) setCollapsed(true);
        else if (["changed", "failed", "reviewing", "ready"].includes(stage) || isEmpty) setCollapsed(false);
      }, [stage, isEmpty]);
      React.useEffect(() => {
        if (!isEmpty) return undefined;
        let live = true;
        assertModelReady(rootContext).then(
          () => { if (live) setModel("ready"); },
          (error) => { if (live) setModel(error?.code === "model_unavailable" ? "unavailable" : "unknown"); },
        );
        return () => { live = false; };
      }, [isEmpty, id]);
      const prefill = (example) => {
        if (firstTurnPending || String(input?.draft || "").trim() || typeof inputActions?.setDraft !== "function") return;
        inputActions.setDraft(example.draft);
        setPrefilled(true);
      };
      const openBrief = (event) => openOverlay("brief", id, event.currentTarget);
      const runGuidanceAction = (event) => {
        if (canonicalSessionElsewhere(project, id)) {
          rootContext.sessions.open(project.work.sessionId);
          return;
        }
        openBrief(event);
      };
      if (!workspace) return null;
      if (!record || ["idle", "loading"].includes(record.status)) return h("section", {
        className: "wx-guidance wx-guidance-sync",
        "aria-label": "万象工作引导",
        "aria-busy": "true",
      }, h("span", { className: "wx-guidance-dot", "aria-hidden": "true" }), h("span", null, "正在同步工作引导…"));
      if (record.status === "error" && guidance.progress.allKnown === 0) {
        const importRequired = record.errorCode === "workspace_outside_managed_root";
        return h("section", {
          className: "wx-guidance wx-guidance-sync",
          "data-tone": "problem",
          "aria-label": "万象工作引导",
          "aria-busy": record.busy ? "true" : undefined,
          role: "alert",
        }, h("span", { className: "wx-guidance-dot", "aria-hidden": "true" }), h("span", null, importRequired
          ? record.busy ? "正在导入项目并载入工作说明…" : "这个项目尚未导入万象。导入后即可载入工作说明并开始使用。"
          : "暂时无法载入工作说明。"),
        h("button", {
          type: "button",
          className: "wx-guidance-link",
          disabled: record.busy,
          onClick: () => void (importRequired ? importWorkspace(workspace.workspaceId) : loadProject(workspace.workspaceId)),
        }, importRequired ? record.busy ? "正在导入…" : "导入并开始使用" : "重新同步"));
      }
      if (isEmpty) return h("section", { className: "wx-guidance wx-guidance-empty", "data-tone": guidanceTone(stage), "aria-label": "万象工作引导" },
        h("div", { className: "wx-guidance-kicker" }, h(Mark, { size: 22 }), h("span", null, "从真实工作开始")),
        h("h2", null, "不用先想清楚怎么做，先把工作交代给万象"),
        h("p", { className: "wx-guidance-intro" }, "万象会在同一段对话里理解需求、整理工作说明，再用真实材料制作和验收。"),
        h("ol", { className: "wx-guidance-steps", "aria-label": "从理解到制作的四步" }, [
          ["描述真实工作", "说清现在怎么做、哪里最耗时"],
          ["提供真实材料", "添加文件、网页或过去案例"],
          ["确认工作说明", "核对目标、输入、交付物与验收"],
          ["制作并验收", "在真实材料上运行并修正"],
        ].map(([title, copy], index) => h("li", { key: title }, h("span", null, index + 1), h("div", null, h("strong", null, title), h("small", null, copy))))),
        h("p", { className: "wx-guidance-question" }, h("span", null, "先回答这一问"), "先讲一件最近真实发生、而且会重复的工作；最好同时提供一份材料或过去做对的案例。"),
        h("div", { className: "wx-guidance-examples", "aria-label": "可填入输入框的真实工作示例" }, guidanceExamples.map((example) => h("button", {
          key: example.label,
          type: "button",
          disabled: !canPrefill,
          title: canPrefill ? `把“${example.label}”放入输入框` : "输入框已有内容，不会覆盖",
          onClick: () => prefill(example),
        }, example.label))),
        firstTurnPending ? h("p", { className: "wx-guidance-prefill", role: "status" }, "第一条描述正在发送，示例暂时不可用。")
          : prefilled || draftText.trim() ? h("p", { className: "wx-guidance-prefill", role: "status" }, prefilled ? "示例已放入输入框，可继续修改后发送。" : "输入框已有内容，示例不会覆盖。") : null,
        model === "unavailable" ? h("div", { className: "wx-model-inline", role: "status" },
          h("span", null, "还没有可用的模型连接。你可以先写好工作描述，连接后再发送。"),
          h("button", { type: "button", onClick: (event) => openOverlay("model", id, event.currentTarget) }, "查看连接方法")) : null,
        model === "unknown" ? h("p", { className: "wx-model-unknown", role: "status" }, "暂时无法检查模型连接；工作说明仍会保存在本机。") : null);

      const collapsible = ["understanding", "reviewing", "ready"].includes(stage);
      const forceCompact = collapsed || ["making", "activating"].includes(stage);
      if (forceCompact) return h("section", { className: "wx-guidance wx-guidance-compact", "data-tone": guidanceTone(stage), "data-collapsed": "true", "aria-label": "万象工作引导" },
        h("div", { className: "wx-guidance-compact-main" },
          h("span", { className: "wx-guidance-dot", "aria-hidden": "true" }),
          h("strong", null, guidanceTitle(stage)),
          h(GuidanceProgress, { guidance, answers: project.answers })),
        collapsible ? h("button", { type: "button", className: "wx-guidance-link", onClick: () => setCollapsed(false), "aria-expanded": "false", "aria-controls": guidanceContentId }, "展开引导")
          : h("button", { type: "button", className: "wx-guidance-link", onClick: runGuidanceAction }, guidanceActionLabel(guidance, project, id)));

      return h("section", { className: "wx-guidance wx-guidance-active", "data-tone": guidanceTone(stage), "aria-label": "万象工作引导" },
        h("header", { className: "wx-guidance-head" },
          h("div", null, h("span", { className: "wx-guidance-dot", "aria-hidden": "true" }), h("strong", null, guidanceTitle(stage))),
          collapsible ? h("button", { type: "button", className: "wx-guidance-link", onClick: () => setCollapsed(true), "aria-expanded": "true", "aria-controls": guidanceContentId }, "收起") : null),
        h("div", { id: guidanceContentId, className: "wx-guidance-body" },
          h(GuidanceProgress, { guidance, answers: project.answers }),
          h("p", { className: "wx-guidance-next" }, h("span", null, "下一步"), guidance.next.prompt),
          h("button", { type: "button", className: "wx-guidance-brief", onClick: runGuidanceAction }, h(Icon, { name: "brief", size: 15 }), guidanceActionLabel(guidance, project, id))));
    }
    function statusOf(record) {
      if (!record || record.status === "idle" || record.status === "loading") return "正在同步";
      if (record.conflict) return "核对最新修改";
      if (record.error && record.project.phase !== "failed") return "重新同步";
      if (record.project.work.activation?.status === "pending") return "正在准备制作";
      if (record.project.phase === "failed") return "恢复制作";
      if (record.project.phase === "changed") return "确认修改并继续";
      if (record.project.phase === "making") return `制作中 · v${record.project.work.activeRevision}`;
      if (record.project.phase === "ready") return record.project.guidance?.next?.kind === "review_and_confirm" ? "查看并确认工作说明" : "开始制作";
      const known = fields.filter((field) => !isPlaceholderAnswer(record.project.answers[field.key])).length;
      return known ? `理解中 · ${known}/7` : "理解中";
    }
    function statusTone(record) {
      if (record?.conflict || record?.project.phase === "failed" || record?.error) return "problem";
      if (record?.project.phase === "making") return "active";
      if (record?.project.phase === "changed" || record?.project.phase === "ready") return "attention";
      return "quiet";
    }
    function HeaderBadge({ sessionId }) {
      const workspace = useWorkspace(sessionId);
      const record = useRecord(workspace?.workspaceId);
      if (!workspace) return null;
      return h("button", { type: "button", className: "wx-badge", "data-tone": statusTone(record), onClick: (event) => openOverlay("brief", sessionId, event.currentTarget), title: "打开工作说明" },
        h(Icon, { name: "brief", size: 15 }), h("span", null, statusOf(record)));
    }
    function CommunityButton({ wide }) {
      return h("button", { type: "button", className: "wx-side", title: "打开社群支持", onClick: (event) => openOverlay("community", rootContext.sessions.list.getSnapshot().current, event.currentTarget) },
        h(Icon, { name: "community" }), wide ? h("span", null, "社群支持") : null);
    }

    function SourcePill({ source }) {
      const status = source?.status || "unresolved";
      return h("span", { className: "wx-source", "data-source": status }, sourceLabels[status] || sourceLabels.unresolved);
    }
    function BriefField({ workspaceId, field, record }) {
      const project = record.project;
      const source = project.fieldSources[field.key];
      const saved = project.answers[field.key] || "";
      const draft = record.draft.answers[field.key];
      const value = draft === undefined ? saved : draft;
      const changed = value.trim() !== saved;
      const confirmable = !isPlaceholderAnswer(saved) && source.status !== "user_confirmed" && !changed;
      const save = async (confirmOnly = false) => {
        const next = confirmOnly ? saved : value.trim();
        const status = next ? "user_confirmed" : "unresolved";
        try {
          await putProject(workspaceId, {
            answers: { [field.key]: next },
            fieldSources: { [field.key]: { status, sourceMessageIds: confirmOnly ? source.sourceMessageIds : [] } },
          }, field.key);
        } catch {}
      };
      return h("section", { className: "wx-brief-field", "data-required": field.required || undefined },
        h("div", { className: "wx-field-head" }, h("div", null, h("h3", null, field.label), field.required ? h("span", null, "制作前确认") : null), h(SourcePill, { source })),
        h("textarea", {
          value,
          rows: Math.max(2, Math.min(5, Math.ceil((value.length || 48) / 34))),
          placeholder: field.placeholder,
          disabled: record.busy,
          onChange: (event) => setDraft(workspaceId, { answers: { [field.key]: event.target.value } }),
          onKeyDown: (event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && changed) void save(false); },
        }),
        h("div", { className: "wx-field-foot" },
          !field.required && !saved && !changed ? h("span", null, "未补充时将在制作中验证") : h("span", null, changed ? "尚未保存" : "已同步"),
          changed ? h("button", { type: "button", disabled: record.busy, onClick: () => void save(false) }, "保存")
            : confirmable ? h("button", { type: "button", disabled: record.busy, onClick: () => void save(true) }, "确认这项") : null),
      );
    }
    function activationReady(project) {
      return requiredKeys.every((key) => !isPlaceholderAnswer(project.answers[key]));
    }
    function actionLabel(project, sessionId) {
      if (canonicalSessionElsewhere(project, sessionId)) return "返回制作会话";
      if (project.phase === "making" && project.work.activeRevision === project.briefRevision) return "返回制作会话";
      if (project.phase === "changed") return "确认修改并继续制作";
      if (project.phase === "failed") return "重新开始制作";
      if (project.guidance?.stage === "reviewing") return "确认工作说明并开始制作";
      return "开始制作";
    }
    function RunEvidencePanel({ project }) {
      const cases = project.evaluation.cases;
      const runs = project.runs.order.map((runId) => project.runs.byId[runId]).filter(Boolean);
      const latestForCase = (caseId) => [...runs].reverse().find((run) => run.caseId === caseId);
      const statusLabel = (run) => {
        if (!run) return "未运行";
        if (run.status === "running") return "运行中";
        if (run.status === "passed") return "通过";
        if (run.status === "cancelled") return "已取消";
        if (run.conclusion === "timed_out") return "超时";
        if (run.conclusion === "interrupted") return "运行时重启 · 未通过";
        return "未通过";
      };
      return h("section", { className: "wx-evidence", "aria-labelledby": "wx-evidence-title", "aria-live": "polite" },
        h("div", { className: "wx-evidence-head" },
          h("h3", { id: "wx-evidence-title" }, "运行证据"),
          h("dl", null,
            h("div", null, h("dt", null, "Workflow 版本"), h("dd", null, project.evaluation.workflowVersion ? `v${project.evaluation.workflowVersion}` : "尚未就绪")),
            h("div", null, h("dt", null, "Eval 修订"), h("dd", null, Number.isInteger(project.evaluation.evalRevision) ? `r${project.evaluation.evalRevision}` : "尚未就绪")))),
        h("h4", null, "逐案例结果"),
        cases.length ? h("ul", { className: "wx-case-results" }, cases.map((evalCase) => {
          const run = latestForCase(evalCase.id);
          return h("li", { key: evalCase.id, "data-status": run?.status || "idle" },
            h("div", null, h("strong", null, evalCase.title), evalCase.kind === "boundary" ? h("span", null, "边界案例") : null),
            h("b", null, statusLabel(run)),
            run?.evidence?.error?.message ? h("p", { role: "alert" }, run.evidence.error.message) : null,
            run?.retryOf ? h("small", null, "前次运行 ", run.retryOf) : null,
            run ? h("small", null, "runId ", run.runId) : null);
        })) : h("p", { className: "wx-evidence-empty" }, "尚无可见的代表案例。"),
        runs.length ? h("details", { className: "wx-run-history" },
          h("summary", null, `历史运行 ${runs.length} 次`),
          h("ol", null, [...runs].reverse().map((run) => {
            const assertions = Array.isArray(run.evidence?.assertions) ? run.evidence.assertions : [];
            const passedAssertions = assertions.filter((assertion) => assertion?.passed === true).length;
            return h("li", { key: run.runId },
              h("span", null, run.runId), h("b", null, statusLabel(run)),
              h("small", null, `Workflow v${run.workflowVersion} · Eval r${run.evalRevision}`),
              assertions.length ? h("small", null, `断言 ${passedAssertions}/${assertions.length}`) : null,
              run.evidence?.error?.message ? h("p", { role: "alert" }, run.evidence.error.message) : null,
              run.retryOf ? h("small", null, "前次运行 ", run.retryOf) : null);
          }))) : null);
    }
    function BriefPanel({ workspace, sessionId }) {
      const workspaceId = workspace.workspaceId;
      const record = useRecord(workspaceId);
      const project = record.project;
      React.useEffect(() => { ensureProject(workspaceId); void loadProject(workspaceId, true); }, [workspaceId]);
      const nameDraft = record.draft.projectName ?? project.projectName;
      const nameChanged = nameDraft.trim() !== project.projectName;
      const saveName = async () => {
        const value = nameDraft.trim();
        if (!value || !nameChanged) return;
        try { await putProject(workspaceId, { projectName: value }, "projectName"); } catch {}
      };
      const ready = activationReady(project);
      const returnToCanonical = canonicalSessionElsewhere(project, sessionId);
      const canReturn = returnToCanonical
        || (Number.isInteger(project.work.activeRevision) && project.work.activeRevision === project.briefRevision);
      const run = () => {
        const target = project.work.sessionId;
        if (canReturn && target) { rootContext.sessions.open(target); closeOverlay(); return; }
        void activateProject(rootContext, workspaceId, sessionId);
      };
      return h("div", { className: "wx-brief-panel" },
        h("header", { className: "wx-panel-head" },
          h("div", null, h("p", null, "动态工作契约"), h("h2", null, "工作说明")),
          h("span", { className: "wx-panel-status", "data-tone": statusTone(record) }, statusOf(record))),
        h("label", { className: "wx-project-name" }, "项目名称", h("input", {
          value: nameDraft,
          disabled: record.busy,
          onChange: (event) => setDraft(workspaceId, { projectName: event.target.value }),
          onBlur: saveName,
          onKeyDown: (event) => { if (event.key === "Enter") event.currentTarget.blur(); },
        })),
        record.conflict ? h("div", { className: "wx-alert", "data-kind": "warning", role: "alert" }, "另一处已更新这份工作说明。最新内容已经载入，你未保存的文字仍保留在输入框中。") : null,
        record.error ? h("div", { className: "wx-alert", "data-kind": "error", role: "alert" },
          h("span", null, record.error),
          h("button", { type: "button", disabled: record.busy, onClick: () => void (record.errorCode === "workspace_outside_managed_root" ? importWorkspace(workspaceId) : loadProject(workspaceId)) },
            record.errorCode === "workspace_outside_managed_root" ? "导入项目" : "重新同步")) : null,
        h(RunEvidencePanel, { project }),
        h("div", { className: "wx-brief-fields" }, fields.map((field) => h(BriefField, { key: field.key, workspaceId, field, record }))),
        h("section", { className: "wx-run-preview", "aria-label": "制作前预览" },
          h("h3", null, "制作前预览"),
          h("dl", null,
            h("div", null, h("dt", null, "项目目录"), h("dd", null, workspace.path || "当前项目目录")),
            h("div", null, h("dt", null, "写入范围"), h("dd", null, "仅当前项目；危险操作会先询问")),
            h("div", null, h("dt", null, "计划动作"), h("dd", null, "制作最小结果 → 用真实材料运行 → 按验收标准修正")))),
        !project.readiness.ready ? h("p", { className: "wx-readiness" }, "还需明确：", project.readiness.missingRequired.map((key) => fields.find((field) => field.key === key)?.label).filter(Boolean).join("、")) : null,
        h("button", { type: "button", className: "wx-primary wx-activate", disabled: record.busy || (!canReturn && !ready), onClick: run }, record.busy ? "正在准备…" : actionLabel(project, sessionId)),
        h("p", { className: "wx-activation-note" }, returnToCanonical
          ? "制作只在项目的主会话继续；先返回该对话，再确认并同步修改。"
          : ready
            ? "点击后会原子确认当前工作说明，并在这个对话里开始制作。"
            : "补全四项制作条件后，可一次确认工作说明并开始制作。"));
    }

    function useFocusTrap(onClose, restoreTarget) {
      const ref = React.useRef(null);
      const onCloseRef = React.useRef(onClose);
      onCloseRef.current = onClose;
      React.useEffect(() => {
        const restore = restoreTarget?.isConnected ? restoreTarget : document.activeElement;
        const node = ref.current;
        if (!node) return undefined;
        const focusable = () => [...node.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[href],[tabindex]:not([tabindex="-1"])')]
          .filter((item) => item.getClientRects().length > 0);
        (focusable()[0] || node).focus();
        const keydown = (event) => {
          if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); return; }
          if (event.key !== "Tab") return;
          const items = focusable();
          if (!items.length) { event.preventDefault(); node.focus(); return; }
          const first = items[0], last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        };
        document.addEventListener("keydown", keydown);
        return () => { document.removeEventListener("keydown", keydown); if (restore?.isConnected) restore.focus?.(); };
      }, []);
      return ref;
    }
    function DrawerFrame({ label, restoreTarget, children, className = "" }) {
      const ref = useFocusTrap(closeOverlay, restoreTarget);
      return h(React.Fragment, null,
        h("button", { type: "button", className: "wx-backdrop", "aria-label": `关闭${label}`, onClick: closeOverlay }),
        h("aside", { ref, className: `wx-drawer ${className}`.trim(), role: "dialog", "aria-modal": "true", "aria-label": label, tabIndex: -1 },
          h("button", { type: "button", className: "wx-close", "aria-label": "关闭", onClick: closeOverlay }, h(Icon, { name: "close" })), children));
    }
    function BriefDrawer({ sessionId, restoreTarget }) {
      const id = sessionId || rootContext.sessions.list.getSnapshot().current;
      const workspace = id ? workspaceForSession(rootContext, id) : undefined;
      return h(DrawerFrame, { label: "工作说明", restoreTarget, className: "wx-brief-drawer" },
        workspace ? h(BriefPanel, { workspace, sessionId: id }) : h("div", { className: "wx-empty" }, "请先打开一个项目对话。"));
    }
    function CommunityDrawer({ sessionId, restoreTarget }) {
      const workspaceId = sessionId ? workspaceForSession(rootContext, sessionId)?.workspaceId : undefined;
      const [mode, setMode] = React.useState("咨询");
      const [draft, setCommunityDraft] = React.useState("");
      const [items, setItems] = React.useState([]);
      const [state, setState] = React.useState({ busy: true, error: "", saved: false });
      const reload = React.useCallback(async () => {
        try {
          const body = await apiJson("/api/wanxiang/community-outbox");
          setItems(Array.isArray(body) ? body : body?.items || []);
          setState((value) => ({ ...value, busy: false, error: "" }));
        } catch (error) { setState((value) => ({ ...value, busy: false, error: error.message })); }
      }, []);
      React.useEffect(() => { void reload(); }, [reload]);
      const save = async () => {
        if (!draft.trim()) return;
        setState({ busy: true, error: "", saved: false });
        try {
          await apiJson("/api/wanxiang/community-outbox", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...(workspaceId ? { workspaceId } : {}), kind: mode === "咨询" ? "question" : "feedback", message: draft.trim() }),
          });
          setCommunityDraft("");
          setState({ busy: false, error: "", saved: true });
          await reload();
        } catch (error) { setState({ busy: false, error: error.message, saved: false }); }
      };
      const remove = async (id) => {
        try { await apiJson(`/api/wanxiang/community-outbox?id=${encodeURIComponent(id)}`, { method: "DELETE" }); await reload(); }
        catch (error) { setState((value) => ({ ...value, error: error.message })); }
      };
      return h(DrawerFrame, { label: "社群支持", restoreTarget, className: "wx-community-drawer" },
        h("header", { className: "wx-community-head" }, h(Mark, { size: 34 }), h("div", null, h("p", null, "外部支持服务"), h("h2", null, "社群支持"))),
        h("div", { className: "wx-local-note", role: "note" }, h("strong", null, "仅保存在本机，尚未发送"), h("span", null, "当前版本不会把内容传给社群，也不会替你确认需求或执行项目动作。")),
        h("div", { className: "wx-modes", role: "group", "aria-label": "留言类型" }, ["咨询", "反馈"].map((item) => h("button", { key: item, type: "button", className: mode === item ? "active" : "", "aria-pressed": mode === item, onClick: () => setMode(item) }, item))),
        h("textarea", { className: "wx-community-input", value: draft, rows: 6, placeholder: mode === "咨询" ? "描述你卡住的地方…" : "告诉我们哪里需要改进…", onChange: (event) => setCommunityDraft(event.target.value) }),
        h("button", { type: "button", className: "wx-primary", disabled: state.busy || !draft.trim(), onClick: save }, state.busy ? "正在保存…" : "加入本机待发送箱"),
        state.saved ? h("div", { className: "wx-alert", "data-kind": "success", role: "status" }, "已加入本机待发送箱。") : null,
        state.error ? h("div", { className: "wx-alert", "data-kind": "error", role: "alert" }, state.error) : null,
        h("section", { className: "wx-outbox" }, h("h3", null, "本机历史"), items.length
          ? items.map((item, index) => h("article", { key: item.id || index },
            h("div", null, h("strong", null, item.kind === "question" ? "咨询" : "反馈"), h("time", null, item.createdAt ? new Date(item.createdAt).toLocaleString() : "")),
            h("p", null, item.message || ""), h("button", { type: "button", onClick: () => void remove(item.id) }, "删除")))
          : h("p", null, "还没有本机待发送记录。")));
    }
    function ModelConnectionDrawer({ restoreTarget }) {
      return h(DrawerFrame, { label: "模型连接", restoreTarget, className: "wx-model-drawer" },
        h("header", { className: "wx-community-head" }, h(Mark, { size: 34 }), h("div", null, h("p", null, "开始制作前检查"), h("h2", null, "连接一个可用模型"))),
        h("div", { className: "wx-local-note", role: "note" }, h("strong", null, "没有改动项目"), h("span", null, "本次操作没有确认工作说明，也没有切换项目写入权限。")),
        h("p", { className: "wx-model-copy" }, "请打开左侧“高级设置”，进入“模型连接”配置可用提供方。完成后回到工作说明，再次点击“开始制作”。"),
        h("button", { type: "button", className: "wx-primary", onClick: closeOverlay }, "知道了"));
    }
    function OverlayRoot() {
      const value = useOverlay();
      if (!value) return null;
      if (value.kind === "community") return h(CommunityDrawer, { sessionId: value.sessionId, restoreTarget: value.trigger });
      if (value.kind === "model") return h(ModelConnectionDrawer, { restoreTarget: value.trigger });
      return h(BriefDrawer, { sessionId: value.sessionId, restoreTarget: value.trigger });
    }
    function NoWelcomeNotice({ complete }) { React.useEffect(() => { complete(); }, [complete]); return null; }

    function valueAt(root, path) {
      let value = root;
      for (const key of path || []) value = value && typeof value === "object" ? value[key] : undefined;
      return value;
    }
    function modelConnectionError(message) { return Object.assign(new Error(message), { code: "model_unavailable" }); }
    async function assertModelReady(ctx) {
      const [registered, declared, settings] = await Promise.all([ctx.remote.llm.listProviders(), ctx.remote.llm.listConfigurableProviders(), ctx.remote.settings.describe()]);
      if (!registered.ok || !declared.ok) throw new Error("暂时无法检查模型连接，请稍后重试。");
      const declaredIds = new Set(declared.value.map((item) => item.provider));
      if (!settings.ok) {
        if (registered.value.some((item) => !declaredIds.has(item.id))) return;
        const deepseek = await ctx.remote.credentials.describe(["DEEPSEEK_API_KEY"]);
        if (deepseek.ok && registered.value.some((item) => item.id === "deepseek-official") && deepseek.value.DEEPSEEK_API_KEY?.configured === true) return;
        throw modelConnectionError("尚未找到可用的模型连接。");
      }
      const namespaces = new Map(settings.value.namespaces.map((item) => [item.ns, item]));
      const references = new Set(["DEEPSEEK_API_KEY"]);
      const providers = [];
      for (const provider of registered.value) {
        const entry = declared.value.find((item) => item.provider === provider.id);
        if (!entry) { providers.push({ active: true }); continue; }
        const profile = valueAt(namespaces.get(entry.settingsNs)?.value, entry.settingsPath);
        const apiKeyEnv = typeof profile?.apiKeyEnv === "string" && profile.apiKeyEnv ? profile.apiKeyEnv : undefined;
        if (apiKeyEnv) references.add(apiKeyEnv);
        providers.push({ active: true, apiKeyEnv });
      }
      const credentials = await ctx.remote.credentials.describe([...references]);
      if (!credentials.ok) throw new Error("暂时无法检查模型凭据，请稍后重试。");
      const ready = providers.some((provider) => !provider.apiKeyEnv || credentials.value[provider.apiKeyEnv]?.configured === true);
      if (!ready && registered.value.some((item) => item.id === "deepseek-official") && credentials.value.DEEPSEEK_API_KEY?.configured === true) return;
      if (!ready) throw modelConnectionError("开始制作前需要可用的模型连接。");
    }
    function activationPrompt(project) {
      const contract = project.confirmedAnswers || project.answers;
      return `开始制作工作说明 v${project.confirmedRevision ?? project.briefRevision}。\n\n请把下面内容作为当前工作的明确契约，并在这个对话里继续：\n\n# ${project.projectName}\n\n${fields.map((field) => `## ${field.label}\n${contract[field.key] || "制作中验证"}`).join("\n\n")}\n\n先说明最小可验证结果和预计写入范围，再开始制作。用真实材料运行，并逐项给出验收证据；仅生成代码或口头声称完成不算完成。`;
    }
    function activationFailure(error) {
      const text = String(error?.message || error || "");
      if (error?.code === "model_unavailable" || /model|provider|credential|api.?key/i.test(text)) return { code: "model_unavailable", message: "模型连接不可用", recoverable: true };
      if (error?.code === "session_not_live") return { code: "session_not_live", message: "当前对话尚未就绪", recoverable: true };
      if (error?.code === "session_busy" || /running|busy|queue|approval/i.test(text)) return { code: "session_busy", message: "当前对话仍在运行或等待确认", recoverable: true };
      if (/network|fetch|connect|gateway/i.test(text)) return { code: "network_unavailable", message: "网络或服务连接失败", recoverable: true };
      if (/permission|forbidden|unauthorized/i.test(text)) return { code: "permission_denied", message: "项目写入权限切换失败", recoverable: true };
      return { code: "activation_failed", message: "制作指令发送失败", recoverable: true };
    }
    function hasActivationEvidence(session, activationId) {
      if (!session || !activationId) return false;
      const snapshot = session.getSnapshot?.();
      if (snapshot?.queue?.some((item) => String(item.rpcId || "") === activationId)) return true;
      if (snapshot?.pendingSubmissions?.some((item) => String(item.requestId || "") === activationId)) return true;
      const entries = session.eventSource?.getSnapshot?.().entries || [];
      return entries.some((entry) => entry.type === "event" && entry.event?.type === "user/message"
        && String(entry.event?.data?.source?.rpcId || entry.event?.data?.message?.source?.rpcId || "") === activationId);
    }
    async function finishActivation(workspaceId, activationId, status, messageId, error) {
      return apiJson("/api/wanxiang/activation", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, activationId, status, ...(messageId ? { messageId } : {}), ...(error ? { error } : {}) }),
      });
    }
    async function activateProject(ctx, workspaceId, sessionId) {
      const record = recordFor(workspaceId);
      const hadActiveContract = Number.isInteger(record.project.work.activeRevision);
      if (!activationReady(record.project)) return replaceRecord(workspaceId, { error: "请先补全目标、真实输入、交付物和验收标准。" });
      replaceRecord(workspaceId, { busy: true, error: "", errorCode: "", conflict: false });
      try {
        await assertModelReady(ctx);
        const body = await apiJson("/api/wanxiang/activation", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workspaceId, sessionId, baseVersion: record.project.baseVersion, briefRevision: record.project.briefRevision,
            ...(record.project.work.activation?.status === "failed" ? { retry: true } : {}),
          }),
        });
        assertGeneration();
        const project = normalizeProject(body, workspaceId);
        replaceRecord(workspaceId, { project, busy: true, error: "", errorCode: "" });
        const canonicalSessionId = project.work.sessionId || body.activation?.sessionId || sessionId;
        if (["already-active", "existing-session"].includes(body.result)) {
          if (canonicalSessionId) ctx.sessions.open(canonicalSessionId);
          replaceRecord(workspaceId, { busy: false }); broadcast(workspaceId); closeOverlay(); return;
        }
        const activationId = body.activationId || body.activation?.id || project.work.activation?.id;
        if (!activationId) throw new Error("万象没有返回制作编号，请重试。");
        const session = ctx.sessions.binding(canonicalSessionId)?.session;
        if (body.result === "in-progress") {
          if (session && hasActivationEvidence(session, activationId)) {
            await finishActivation(workspaceId, activationId, "active", activationId);
            await loadProject(workspaceId, true);
          } else replaceRecord(workspaceId, { error: "同一版工作说明正在准备制作，不会重复发送。", errorCode: "activation_in_progress" });
          ctx.sessions.open(canonicalSessionId); replaceRecord(workspaceId, { busy: false }); closeOverlay(); return;
        }
        if (body.result !== "reserved") throw new Error("万象返回了无法识别的制作状态，请重试。");
        let sent;
        try {
          if (!session) throw Object.assign(new Error("当前对话尚未就绪，请稍后重试。"), { code: "session_not_live" });
          sent = await session.prompt([{ type: "text", text: activationPrompt(project) }], "queue", undefined, activationId);
          if (!sent.ok) throw Object.assign(new Error(sent.error?.message || "消息发送失败"), { code: sent.error?.code });
        } catch (error) {
          const failure = activationFailure(error);
          let rolledBack = false;
          try { await finishActivation(workspaceId, activationId, "failed", null, failure); rolledBack = true; } catch {}
          const recovery = !rolledBack
            ? "制作指令没有发送，但本机状态尚未完成回滚；请重新打开工作说明恢复。"
            : hadActiveContract
              ? "本次修改没有同步，仍沿用上一版制作契约。"
              : "项目已经恢复为只读理解状态。";
          throw Object.assign(new Error(`${failure.message}。${recovery}`), { code: failure.code });
        }
        try {
          await finishActivation(workspaceId, activationId, "active", sent.value?.messageId || sent.messageId || activationId);
        } catch {
          ctx.sessions.open(canonicalSessionId);
          await loadProject(workspaceId, true);
          replaceRecord(workspaceId, { busy: false, error: "制作指令已经提交，但本机状态尚未同步；重新打开工作说明即可继续对账。" });
          broadcast(workspaceId); closeOverlay(); return;
        }
        ctx.sessions.open(canonicalSessionId);
        await loadProject(workspaceId, true);
        replaceRecord(workspaceId, { busy: false, error: "", errorCode: "" });
        broadcast(workspaceId); closeOverlay();
      } catch (error) {
        if (error.code === "model_unavailable") {
          const trigger = overlay?.trigger;
          replaceRecord(workspaceId, { busy: false, error: "请先完成模型连接，再开始制作。", errorCode: error.code });
          openOverlay("model", sessionId, trigger);
        } else if (error.status === 409 && ["revision_conflict", "brief_revision_conflict"].includes(error.code)) {
          await loadProject(workspaceId, true);
          replaceRecord(workspaceId, { busy: false, conflict: true, error: "工作说明已在别处更新，请核对后再次确认。", errorCode: error.code });
        } else {
          const messages = {
            brief_incomplete: "请先补全目标、真实输入、交付物和验收标准。",
            session_busy: "当前对话仍在运行或等待确认，请完成后再开始制作。",
            session_workspace_mismatch: "当前对话不属于这个项目，请回到项目对话后重试。",
            subagent_forbidden: "子任务对话不能成为项目的制作对话。",
            permission_unavailable: "项目权限服务暂时不可用，仍保持只读状态。",
            permission_transition_failed: "未能安全切换项目写入权限，仍保持只读状态。",
            permission_changed: "项目权限在准备期间发生变化；万象没有发送制作指令。",
            permission_rollback_failed: "制作没有启动，但权限状态尚未同步；写入操作仍会被万象阻止。",
            session_not_live: "当前对话尚未就绪，请重新打开后再试。",
          };
          replaceRecord(workspaceId, { busy: false, error: messages[error.code] || error.message, errorCode: error.code });
        }
      }
    }

    function toolFields(block) {
      const call = "kind" in block ? block.call : block;
      if (!call?.argsRaw) return [];
      try {
        const parsed = JSON.parse(call.argsRaw);
        const patch = parsed.patch || parsed.answers || {};
        return Object.keys(patch.answers || patch).filter((key) => fieldKeys.has(key));
      } catch { return []; }
    }
    function proxyRunCase(block) {
      const call = "kind" in block ? block.call : block;
      if (!call?.argsRaw) return "代表案例";
      try {
        const caseId = JSON.parse(call.argsRaw).caseId;
        return proxyRunCaseLabels[caseId] || caseId || "代表案例";
      } catch { return "代表案例"; }
    }

    function proxyRunRetry(block) {
      const call = "kind" in block ? block.call : block;
      if (!call?.argsRaw) return null;
      try {
        const retryOf = JSON.parse(call.argsRaw).retryOf;
        return typeof retryOf === "string" && retryOf ? retryOf : null;
      } catch { return null; }
    }

    function proxyRunConclusion(block) {
      if (!("kind" in block)) return "running";
      const errorCode = block.error?.code;
      if (errorCode === "workflow_cancelled") return "cancelled";
      if (errorCode === "workflow_timeout") return "timed_out";
      if (errorCode === "proxy_run_assertion_failed") return "partial_failed";
      return block.isError ? "failed" : "passed";
    }
    function ToolStatusView({ state, copy, inspect, inspectLabel }) {
      return h("div", { className: "wx-tool-brief", "data-state": state, role: state === "error" ? "alert" : "status", "aria-live": "polite" },
        h("span", { className: "wx-tool-icon", "aria-hidden": "true" }, state === "ok" ? h(Icon, { name: "check", size: 13 }) : h(Icon, { name: "brief", size: 13 })),
        h("span", null, copy), inspect ? h("button", { type: "button", onClick: inspect }, inspectLabel) : null);
    }
    function WorkBriefToolView({ block, cwd, sessionId, inspect }) {
      const done = "kind" in block;
      const state = !done ? "running" : block.isError ? "error" : "ok";
      const changed = toolFields(block);
      const sessionWorkspace = useWorkspace(sessionId);
      const workspace = sessionWorkspace || rootContext.workspaces.list.getSnapshot().items.find((item) => item.path === cwd);
      const record = useRecord(workspace?.workspaceId);
      React.useEffect(() => {
        if (!done || block.isError) return;
        if (workspace) void loadProject(workspace.workspaceId, true);
      }, [done, block, workspace?.workspaceId]);
      const labels = changed.map((key) => fieldByKey[key]?.label).filter(Boolean).join("、");
      const count = record?.project.guidance?.progress?.allKnown;
      const progress = Number.isInteger(count) ? ` · 工作说明 ${count}/7` : "";
      const copy = state === "running" ? `正在更新工作说明${labels ? `：${labels}` : ""}`
        : state === "error" ? `工作说明更新失败${labels ? `：${labels}` : ""}`
          : `工作说明已更新${labels ? `：${labels}` : ""}${progress}`;
      return h(ToolStatusView, { state, copy, inspect, inspectLabel: "查看记录" });
    }

    function ProxyRunToolView({ block, inspect }) {
      const conclusion = proxyRunConclusion(block);
      const state = conclusion === "running" ? "running" : conclusion === "passed" ? "ok" : "error";
      const caseTitle = proxyRunCase(block);
      const retry = proxyRunRetry(block) ? " · 重试" : "";
      const labels = {
        running: "代理运行中",
        passed: "代理运行通过",
        partial_failed: "部分失败（已保留完成结果）",
        timed_out: "运行超时",
        cancelled: "运行已取消",
        failed: "未通过",
      };
      const copy = `代理垂直切片 · ${caseTitle} · ${labels[conclusion]}${retry}`;
      return h(ToolStatusView, { state, copy, inspect, inspectLabel: "查看运行证据" });
    }

    function ProductStyles() {
      return h("style", { "data-wanxiang-styles": "v3" }, `
        .wx-mark{box-sizing:border-box;display:inline-grid;place-items:center;flex:none;border-radius:31%;background:var(--dsw-alias-state-business-primary);color:#fff;font-family:ui-serif,"Songti SC","STSong",serif;font-weight:700;line-height:1;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}
        .wx-brand{font:650 19px/1 ui-serif,"Songti SC","STSong",serif;letter-spacing:.12em}.wx-side{box-sizing:border-box;width:100%;min-height:40px;display:flex;align-items:center;gap:10px;padding:8px 10px;border:0;border-radius:12px;background:transparent;color:inherit;font:inherit;cursor:pointer;transition:background-color .14s ease}.wx-side:hover{background:var(--dsw-alias-interactive-bg-hover)}.wx-side>svg{flex:0 0 18px}
        .wx-guidance-sync{min-height:40px;padding:8px 11px;display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 88%,transparent);color:var(--dsw-alias-label-tertiary);font-size:11px}.wx-guidance-sync .wx-guidance-link{margin-left:auto}
        .wx-guidance{box-sizing:border-box;width:min(760px,100%);margin:0 auto;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-text,ui-sans-serif,system-ui)}.wx-guidance-empty{padding:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:18px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 90%,transparent);box-shadow:0 12px 34px rgba(20,31,27,.07);text-align:left}.wx-guidance-kicker{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-state-business-primary);font:650 11px/16px var(--ds-font-family-code,ui-monospace,monospace);letter-spacing:.08em}.wx-guidance-empty h2{max-width:650px;margin:13px 0 7px;font:560 23px/1.38 ui-serif,"Songti SC","STSong",serif}.wx-guidance-intro{max-width:650px;margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.7}.wx-guidance-steps{list-style:none;margin:17px 0 0;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}.wx-guidance-steps li{min-width:0;display:flex;align-items:flex-start;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-base)}.wx-guidance-steps li>span{width:20px;height:20px;flex:none;display:grid;place-items:center;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary);font:650 10px/20px var(--ds-font-family-code,ui-monospace,monospace)}.wx-guidance-steps strong,.wx-guidance-steps small{display:block}.wx-guidance-steps strong{font-size:11px;line-height:1.45}.wx-guidance-steps small{margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:9px;line-height:1.45}.wx-guidance-question{margin:15px 0 0;color:var(--dsw-alias-label-primary);font:500 13px/1.6 var(--ds-font-family-text,ui-sans-serif,system-ui)}.wx-guidance-question span{display:block;margin-bottom:2px;color:var(--dsw-alias-state-business-primary);font:650 10px/15px var(--ds-font-family-code,ui-monospace,monospace);letter-spacing:.08em}.wx-guidance-examples{margin-top:11px;display:flex;flex-wrap:wrap;gap:7px}.wx-guidance-examples button{padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:500 11px/17px var(--ds-font-family-text,ui-sans-serif,system-ui);cursor:pointer;transition:border-color .14s ease,background-color .14s ease,color .14s ease}.wx-guidance-examples button:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent);color:var(--dsw-alias-state-business-primary)}.wx-guidance-examples button:disabled{opacity:.45;cursor:default}.wx-guidance-prefill{margin:8px 0 0;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.5}.wx-guidance-active,.wx-guidance-compact{border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 88%,transparent)}.wx-guidance-active{padding:13px 14px}.wx-guidance[data-tone=problem]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,var(--dsw-alias-bg-layer-1))}.wx-guidance[data-tone=attention]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 34%,var(--dsw-alias-border-l2))}.wx-guidance-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.wx-guidance-head>div,.wx-guidance-compact-main{min-width:0;display:flex;align-items:center;gap:8px}.wx-guidance-head strong,.wx-guidance-compact-main>strong{font:560 13px/19px ui-serif,"Songti SC","STSong",serif}.wx-guidance-dot{width:7px;height:7px;flex:none;border-radius:999px;background:var(--dsw-alias-label-caption)}.wx-guidance[data-tone=active] .wx-guidance-dot{background:var(--dsw-alias-state-business-primary)}.wx-guidance[data-tone=attention] .wx-guidance-dot{background:var(--dsw-alias-state-warn-primary)}.wx-guidance[data-tone=problem] .wx-guidance-dot{background:var(--dsw-alias-state-error-primary)}.wx-guidance-link{flex:none;border:0;padding:3px 2px;background:transparent;color:var(--dsw-alias-label-tertiary);font:500 10px/16px var(--ds-font-family-text,ui-sans-serif,system-ui);cursor:pointer}.wx-guidance-link:hover{color:var(--dsw-alias-state-business-primary)}.wx-guidance-progress{margin-top:9px;display:grid;grid-template-columns:max-content max-content minmax(80px,1fr);align-items:center;gap:9px;color:var(--dsw-alias-label-tertiary);font:500 10px/15px var(--ds-font-family-code,ui-monospace,monospace)}.wx-guidance-progress strong{color:var(--dsw-alias-label-secondary);font-weight:650}.wx-guidance-meter{min-width:0;display:grid;grid-template-columns:repeat(7,minmax(5px,1fr));gap:3px}.wx-guidance-meter i{height:3px;border-radius:999px;background:var(--dsw-alias-border-l2)}.wx-guidance-meter i[data-known]{background:var(--dsw-alias-state-business-primary)}.wx-guidance-next{margin:10px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}.wx-guidance-next span{margin-right:7px;color:var(--dsw-alias-state-business-primary);font:650 9px/14px var(--ds-font-family-code,ui-monospace,monospace);letter-spacing:.06em}.wx-guidance-brief{margin-top:10px;display:inline-flex;align-items:center;gap:6px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-state-business-primary);font:600 11px/17px var(--ds-font-family-text,ui-sans-serif,system-ui);cursor:pointer}.wx-guidance-compact{min-height:40px;padding:7px 10px;display:flex;align-items:center;justify-content:space-between;gap:10px}.wx-guidance-compact-main{flex:1}.wx-guidance-compact .wx-guidance-progress{flex:1;margin:0 0 0 5px;grid-template-columns:max-content max-content minmax(52px,1fr)}.wx-model-inline{box-sizing:border-box;width:100%;margin-top:13px;padding:9px 11px;display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,var(--dsw-alias-border-l1));border-radius:11px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent);color:var(--dsw-alias-label-secondary);font:400 11px/1.5 var(--ds-font-family-text,ui-sans-serif,system-ui);text-align:left}.wx-model-inline button{flex:none;border:0;background:transparent;color:var(--dsw-alias-state-business-primary);font:600 11px/18px var(--ds-font-family-text,ui-sans-serif,system-ui);cursor:pointer}.wx-model-unknown{margin:10px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px}
        .wx-badge{display:inline-flex;align-items:center;gap:7px;min-height:30px;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:500 12px/18px var(--ds-font-family-text,ui-sans-serif,system-ui);cursor:pointer;transition:background-color .14s ease,border-color .14s ease}.wx-badge:hover{background:var(--dsw-alias-interactive-bg-hover)}.wx-badge[data-tone=active]{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,var(--dsw-alias-border-l2));color:var(--dsw-alias-state-business-primary)}.wx-badge[data-tone=attention]{color:var(--dsw-alias-state-warn-primary)}.wx-badge[data-tone=problem]{color:var(--dsw-alias-state-error-primary)}
        .wx-backdrop{pointer-events:auto;position:fixed;inset:0;border:0;background:rgba(14,20,18,.34);backdrop-filter:blur(2px);animation:wx-fade-in .16s ease both}.wx-drawer{pointer-events:auto;box-sizing:border-box;position:fixed;z-index:2;inset:0 0 0 auto;width:min(420px,calc(100vw - 24px));padding:26px 24px 36px;overflow:auto;overscroll-behavior:contain;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-left:1px solid var(--dsw-alias-border-l2);box-shadow:-20px 0 56px rgba(13,24,20,.18);font-family:var(--ds-font-family-text,ui-sans-serif,system-ui);animation:wx-drawer-in .16s ease-out both;outline:none}.wx-drawer :is(button,input,textarea):focus-visible,.wx-guidance button:focus-visible,.wx-side:focus-visible,.wx-badge:focus-visible,.wx-model-inline button:focus-visible,.wx-tool-brief button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.wx-close{position:absolute;top:16px;right:16px;width:36px;height:36px;display:grid;place-items:center;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.wx-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
        .wx-panel-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding-right:40px;margin-bottom:18px}.wx-panel-head p,.wx-community-head p{margin:0 0 4px;color:var(--dsw-alias-state-business-primary);font:650 10px/15px var(--ds-font-family-code,ui-monospace,monospace);letter-spacing:.12em;text-transform:uppercase}.wx-panel-head h2,.wx-community-head h2{margin:0;font:560 28px/1.25 ui-serif,"Songti SC","STSong",serif}.wx-panel-status{flex:none;margin-top:4px;padding:4px 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px}.wx-panel-status[data-tone=active]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary)}.wx-panel-status[data-tone=problem]{color:var(--dsw-alias-state-error-primary)}.wx-project-name{display:block;margin-bottom:14px;color:var(--dsw-alias-label-tertiary);font-size:11px}.wx-project-name input{box-sizing:border-box;width:100%;height:38px;margin-top:6px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:500 13px/20px var(--ds-font-family-text,ui-sans-serif,system-ui);outline:none}.wx-project-name input:focus,.wx-brief-field textarea:focus,.wx-community-input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
        .wx-evidence{margin:0 0 18px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-base)}.wx-evidence-head{display:grid;gap:10px}.wx-evidence h3,.wx-evidence h4{margin:0;font:600 14px/1.4 ui-serif,"Songti SC","STSong",serif}.wx-evidence h4{margin-top:14px;font-size:12px}.wx-evidence dl{margin:0;display:grid;grid-template-columns:1fr 1fr;gap:7px}.wx-evidence dl>div{padding:8px;border-radius:9px;background:var(--dsw-alias-bg-layer-1)}.wx-evidence dt{color:var(--dsw-alias-label-tertiary);font-size:9px}.wx-evidence dd{margin:3px 0 0;color:var(--dsw-alias-label-primary);font:650 11px/1.4 var(--ds-font-family-code,ui-monospace,monospace)}.wx-case-results,.wx-run-history ol{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:6px}.wx-case-results li,.wx-run-history li{padding:9px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px}.wx-case-results li>div{display:flex;align-items:center;gap:6px}.wx-case-results strong{font-size:11px}.wx-case-results li>div span{padding:2px 5px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font-size:8px}.wx-case-results li>b{display:block;margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:10px}.wx-case-results li[data-status=passed]>b{color:var(--dsw-alias-state-success-primary)}.wx-case-results li[data-status=failed]>b,.wx-case-results li[data-status=cancelled]>b{color:var(--dsw-alias-state-error-primary)}.wx-case-results p{margin:5px 0 0;color:var(--dsw-alias-state-error-primary);font-size:10px;line-height:1.45}.wx-case-results small{display:block;margin-top:4px;color:var(--dsw-alias-label-caption);font:9px/1.4 var(--ds-font-family-code,ui-monospace,monospace);overflow-wrap:anywhere}.wx-evidence-empty{margin:8px 0 0;color:var(--dsw-alias-label-tertiary);font-size:10px}.wx-run-history{margin-top:10px}.wx-run-history summary{color:var(--dsw-alias-label-secondary);font-size:10px;cursor:pointer}.wx-run-history li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px;color:var(--dsw-alias-label-tertiary);font:9px/1.4 var(--ds-font-family-code,ui-monospace,monospace)}.wx-run-history li>b{color:var(--dsw-alias-label-secondary)}.wx-run-history li>small,.wx-run-history li>p{grid-column:1/-1}.wx-run-history li>p{margin:0;color:var(--dsw-alias-state-error-primary);font:10px/1.45 var(--ds-font-family-text,ui-sans-serif,system-ui)}
        .wx-alert{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin:10px 0;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:1.55}.wx-alert[data-kind=error]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent);color:var(--dsw-alias-state-error-primary)}.wx-alert[data-kind=success]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent);color:var(--dsw-alias-state-success-primary)}.wx-alert button{flex:none;border:0;background:transparent;color:inherit;text-decoration:underline;cursor:pointer}
        .wx-brief-fields{display:flex;flex-direction:column;gap:10px}.wx-brief-field{padding:13px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 62%,var(--dsw-alias-bg-layer-1));transition:border-color .14s ease}.wx-brief-field:focus-within{border-color:var(--dsw-alias-border-l2)}.wx-field-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}.wx-field-head>div{display:flex;align-items:baseline;gap:7px}.wx-field-head h3{margin:0;font:560 15px/1.35 ui-serif,"Songti SC","STSong",serif}.wx-field-head>div>span{color:var(--dsw-alias-label-caption);font-size:10px}.wx-source{flex:none;padding:3px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font:500 10px/15px var(--ds-font-family-code,ui-monospace,monospace)}.wx-source[data-source=user_confirmed]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 11%,transparent);color:var(--dsw-alias-state-business-primary)}.wx-source[data-source=inferred]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-state-warn-primary)}.wx-brief-field textarea,.wx-community-input{box-sizing:border-box;width:100%;min-height:62px;padding:8px 9px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);font:400 13px/1.62 var(--ds-font-family-text,ui-sans-serif,system-ui);resize:vertical;outline:none}.wx-brief-field textarea::placeholder,.wx-community-input::placeholder{color:var(--dsw-alias-label-caption)}.wx-field-foot{min-height:22px;margin-top:5px;display:flex;justify-content:space-between;align-items:center;gap:10px;color:var(--dsw-alias-label-caption);font-size:10px}.wx-field-foot button{border:0;border-radius:7px;padding:4px 8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary);font:600 11px/16px var(--ds-font-family-text,ui-sans-serif,system-ui);cursor:pointer}
        .wx-run-preview{margin-top:16px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-base)}.wx-run-preview h3{margin:0 0 10px;font:560 15px/1.4 ui-serif,"Songti SC","STSong",serif}.wx-run-preview dl{margin:0;display:grid;gap:7px}.wx-run-preview dl>div{display:grid;grid-template-columns:62px minmax(0,1fr);gap:9px;font-size:11px;line-height:1.55}.wx-run-preview dt{color:var(--dsw-alias-label-tertiary)}.wx-run-preview dd{margin:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.wx-readiness{margin:10px 2px 0;color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:1.5}.wx-primary{box-sizing:border-box;min-height:42px;padding:0 17px;border:0;border-radius:12px;background:var(--dsw-alias-state-business-primary);color:#fff;font:650 13px/20px var(--ds-font-family-text,ui-sans-serif,system-ui);cursor:pointer;transition:background-color .14s ease,transform .14s ease}.wx-primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover);transform:translateY(-1px)}.wx-primary:disabled{opacity:.42;cursor:default}.wx-activate{width:100%;margin-top:14px}.wx-activation-note{margin:8px 4px 0;text-align:center;color:var(--dsw-alias-label-caption);font-size:10px;line-height:1.5}
        .wx-community-head{display:flex;align-items:center;gap:11px;padding-right:42px;margin-bottom:18px}.wx-local-note{display:flex;flex-direction:column;gap:3px;padding:12px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,transparent);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.55}.wx-local-note strong{color:var(--dsw-alias-state-warn-primary);font-size:12px}.wx-modes{display:flex;gap:7px;margin-top:16px}.wx-modes button{padding:6px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:500 12px/18px var(--ds-font-family-text,ui-sans-serif,system-ui);cursor:pointer}.wx-modes button.active{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--dsw-alias-state-business-primary)}.wx-community-input{min-height:130px;margin-top:10px;border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}.wx-community-drawer>.wx-primary{width:100%;margin-top:10px}.wx-outbox{margin-top:24px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:16px}.wx-outbox h3{margin:0 0 10px;font-size:13px}.wx-outbox>p{color:var(--dsw-alias-label-tertiary);font-size:12px}.wx-outbox article{position:relative;margin-top:8px;padding:11px;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-base)}.wx-outbox article>div{display:flex;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:10px}.wx-outbox article p{margin:8px 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}.wx-outbox article button{border:0;padding:0;background:transparent;color:var(--dsw-alias-state-error-primary);font-size:11px;cursor:pointer}.wx-model-copy{margin:18px 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.8}.wx-model-drawer>.wx-primary{width:100%}.wx-empty{padding:58px 10px;color:var(--dsw-alias-label-tertiary);text-align:center;font-size:13px}
        .wx-tool-brief{min-width:0;height:calc(24px + var(--dsh-content-font-delta,0px));display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:24px}.wx-tool-icon{width:16px;height:16px;display:grid;place-items:center;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.wx-tool-brief[data-state=ok]{color:var(--dsw-alias-state-business-primary)}.wx-tool-brief[data-state=ok] .wx-tool-icon{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:inherit}.wx-tool-brief[data-state=error]{color:var(--dsw-alias-state-error-primary)}.wx-tool-brief[data-state=running] .wx-tool-icon{animation:wx-breathe 1.2s ease-in-out infinite}.wx-tool-brief button{margin-left:auto;border:0;background:transparent;color:inherit;font:inherit;font-size:11px;cursor:pointer}
        @keyframes wx-drawer-in{from{opacity:.6;transform:translateX(18px)}to{opacity:1;transform:none}}@keyframes wx-fade-in{from{opacity:0}to{opacity:1}}@keyframes wx-breathe{50%{opacity:.38}}@media(min-width:1100px){.wx-backdrop{display:none}.wx-drawer{width:400px;box-shadow:-12px 0 32px rgba(13,24,20,.12)}}@media(max-width:719px){.wx-drawer{width:min(100%,calc(100vw - 8px));padding:22px 16px 30px}.wx-panel-head h2,.wx-community-head h2{font-size:24px}.wx-panel-status{max-width:112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wx-guidance-empty{padding:15px;border-radius:15px}.wx-guidance-empty h2{font-size:20px}.wx-guidance-steps{grid-template-columns:repeat(2,minmax(0,1fr))}.wx-guidance-examples{display:grid;grid-template-columns:1fr}.wx-guidance-examples button{text-align:left;border-radius:10px}.wx-guidance-compact-main{flex-wrap:wrap}.wx-guidance-compact .wx-guidance-progress{width:100%;flex-basis:100%;margin-left:15px}.wx-guidance-progress{grid-template-columns:max-content max-content minmax(52px,1fr);gap:6px}.wx-model-inline{align-items:flex-start;flex-direction:column}.wx-badge{max-width:132px}.wx-badge>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}@media(prefers-reduced-motion:reduce){.wx-drawer,.wx-backdrop,.wx-tool-brief[data-state=running] .wx-tool-icon{animation:none}.wx-side,.wx-badge,.wx-brief-field,.wx-primary,.wx-guidance-examples button{transition:none}.wx-primary:hover:not(:disabled){transform:none}}
      `);
    }

    const themeTokens = {
      "--dsw-font-markdown-h1": { light: "700 calc(21px + var(--dsh-content-font-delta)) / calc(30px + var(--dsh-content-font-delta)) ui-serif,\"Songti SC\",\"STSong\",serif", dark: "700 calc(21px + var(--dsh-content-font-delta)) / calc(30px + var(--dsh-content-font-delta)) ui-serif,\"Songti SC\",\"STSong\",serif" },
      "--dsw-font-markdown-h2": { light: "700 calc(19px + var(--dsh-content-font-delta)) / calc(28px + var(--dsh-content-font-delta)) ui-serif,\"Songti SC\",\"STSong\",serif", dark: "700 calc(19px + var(--dsh-content-font-delta)) / calc(28px + var(--dsh-content-font-delta)) ui-serif,\"Songti SC\",\"STSong\",serif" },
      "--dsw-font-markdown-h3": { light: "700 calc(18px + var(--dsh-content-font-delta)) / calc(26px + var(--dsh-content-font-delta)) ui-serif,\"Songti SC\",\"STSong\",serif", dark: "700 calc(18px + var(--dsh-content-font-delta)) / calc(26px + var(--dsh-content-font-delta)) ui-serif,\"Songti SC\",\"STSong\",serif" },
      "--dsw-font-markdown-h4": { light: "600 var(--dsh-content-font-size,14px) / calc(24px + var(--dsh-content-font-delta)) ui-serif,\"Songti SC\",\"STSong\",serif", dark: "600 var(--dsh-content-font-size,14px) / calc(24px + var(--dsh-content-font-delta)) ui-serif,\"Songti SC\",\"STSong\",serif" },
      "--dsw-font-markdown-base-strong": { light: "600 var(--dsh-content-font-size,14px) / calc(24px + var(--dsh-content-font-delta)) ui-serif,\"Songti SC\",\"STSong\",serif", dark: "600 var(--dsh-content-font-size,14px) / calc(24px + var(--dsh-content-font-delta)) ui-serif,\"Songti SC\",\"STSong\",serif" },
      "--dsw-alias-bg-base": { light: "#F3F0E8", dark: "#151A18" },
      "--dsw-alias-bg-layer-1": { light: "#FFFEFA", dark: "#242D29" },
      "--dsw-alias-bg-layer-2": { light: "#F8F5ED", dark: "#202824" },
      "--dsw-alias-bg-overlay": { light: "#FFFEFA", dark: "#242D29" },
      "--dsw-alias-bg-module-platform": { light: "#EDE9DE", dark: "#202724" },
      "--dsw-alias-border-l1": { light: "#E4E0D6", dark: "#303A35" },
      "--dsw-alias-border-l2": { light: "#D7D3C8", dark: "#39433E" },
      "--dsw-alias-border-l2-darkmode-thin": { light: "#D7D3C8", dark: "#39433E" },
      "--dsw-alias-brand-primary": { light: "#1F6B57", dark: "#70B99E" },
      "--dsw-alias-label-primary": { light: "#17211F", dark: "#F0EEE7" },
      "--dsw-alias-label-secondary": { light: "#52605B", dark: "#C2C9C4" },
      "--dsw-alias-label-tertiary": { light: "#737D78", dark: "#98A39D" },
      "--dsw-alias-label-caption": { light: "#9A9F99", dark: "#75817A" },
      "--dsw-alias-state-business-primary": { light: "#1F6B57", dark: "#70B99E" },
      "--dsw-alias-state-business-tertiary": { light: "#E2EFE9", dark: "#2B443A" },
      "--dsw-alias-button-info-fill": { light: "#1F6B57", dark: "#5EA98C" },
      "--dsw-alias-button-info-hover": { light: "#185544", dark: "#70B99E" },
      "--dsw-alias-interactive-bg-hover": { light: "#1F6B570D", dark: "#FFFFFF12" },
      "--dsw-alias-interactive-bg-hover-solid": { light: "#E9E5DA", dark: "#2D3732" },
      "--dsw-alias-markdown-code-block": { light: "#ECE9E0", dark: "#111614" },
      "--dsw-alias-markdown-code-block-banner": { light: "#E7E3D9", dark: "#1A211E" },
      "--dsw-alias-markdown-inline-code": { light: "#E9E5DB", dark: "#2B3430" },
      "--dsw-specific-bubble": { light: "#E2EFE9", dark: "#2B443A" },
      "--dsw-specific-input-major": { light: "#FFFEFA", dark: "#242D29" },
      "--dsw-specific-selector": { light: "#ECE9E0", dark: "#303A35" },
      "--dsw-specific-sidebar-fill": { light: "#EEEAE0", dark: "#191F1C" },
      "--dsw-specific-sidebar-nav-item-active": { light: "#FFFEFA", dark: "#2A332F" },
      "--dsw-specific-sidebar-nav-item-active-accent": { light: "#DDEBE5", dark: "#315044" },
      "--dsw-specific-sidebar-nav-item-hover": { light: "#E5E1D6", dark: "#252E2A" },
    };

    function installProductLocale(ctx) {
      const disposers = [];
      const active = ctx.locale.getLocale().active;
      const localeId = active.startsWith("zh") ? "zh-x-wanxiang" : "en-x-wanxiang";
      const fallback = active.startsWith("zh") ? "zh" : "en";
      const zh = localeId.startsWith("zh");
      disposers.push(ctx.locale.addLanguage({ id: localeId, label: zh ? "万象中文" : "Wanxiang English", fallback }));
      disposers.push(ctx.locale.register("conversation", localeId, zh ? {
        "placeholder.default": "继续描述、补充材料或让万象开始工作… / @ 文件或对话",
        "placeholder.hero": "描述一项真实工作，或添加一份材料… / @ 文件或对话",
        "placeholder.workspace": "选择一个项目开始",
        "input.accessMode": "工作模式，当前：{name}",
        "access.preset.readOnly": "理解中 · 只读",
        "access.preset.workspaceWrite": "制作中 · 项目可写",
        "access.preset.fullAccess": "高级访问",
        "hero.headline": "今天想把哪件真实工作交给万象？",
        "hero.preview": "本机项目 · 理解中",
        "hero.chooseWorkspace": "选择项目",
      } : {
        "placeholder.default": "Continue, add material, or ask Wanxiang to work… / @ files or sessions",
        "placeholder.hero": "Describe a real task or add a real example… / @ files or sessions",
        "placeholder.workspace": "Choose a project to begin",
        "input.accessMode": "Work mode: {name}",
        "access.preset.readOnly": "Understanding · Read only",
        "access.preset.workspaceWrite": "Making · Project write",
        "access.preset.fullAccess": "Advanced access",
        "hero.headline": "What real work should Wanxiang take on today?",
        "hero.preview": "Local project · Understanding",
        "hero.chooseWorkspace": "Choose project",
      }));
      disposers.push(ctx.locale.register("workspace", localeId, zh ? {
        "section.workspaces": "项目",
        "groupBy.workspace": "按项目",
        "workspace.add": "添加项目",
        "menu.addWorkspace": "添加项目…",
        "picker.loading": "正在加载项目…",
        "rename.workspace.title": "重命名项目",
        "field.workspaceName": "项目名称",
        "delete.workspace": "移除项目",
        "actions.workspace.aria": "项目“{name}”的操作",
      } : {
        "section.workspaces": "Projects",
        "groupBy.workspace": "By project",
        "workspace.add": "Add project",
        "menu.addWorkspace": "Add project…",
        "picker.loading": "Loading projects…",
        "rename.workspace.title": "Rename project",
        "field.workspaceName": "Project name",
        "delete.workspace": "Remove project",
        "actions.workspace.aria": "Actions for project {name}",
      }));
      disposers.push(ctx.locale.register("sidebar", localeId, zh ? {
        "session.new": "新对话", "session.new.label": "新建对话",
      } : { "session.new": "New conversation", "session.new.label": "New conversation" }));
      disposers.push(ctx.locale.register("settings", localeId, zh ? {
        "trigger": "高级设置", "title": "高级设置", "general.nav": "通用",
      } : { "trigger": "Advanced settings", "title": "Advanced settings", "general.nav": "General" }));
      disposers.push(ctx.locale.register("settings.models", localeId, zh ? {
        "nav": "模型连接", "title": "模型连接",
      } : { "nav": "Model connections", "title": "Model connections" }));
      disposers.push(ctx.locale.register("session-log-download", localeId, zh ? {
        "header.action": "导出运行记录",
        "dialog.preparingTitle": "正在导出运行记录",
        "dialog.preparingDescription": "正在准备包含当前对话、关联对话和附件的 ZIP 文件。",
        "dialog.successTitle": "运行记录已开始下载",
        "dialog.successDescription": "浏览器正在下载运行记录 ZIP 文件。",
        "dialog.errorTitle": "运行记录导出失败",
        "dialog.close": "关闭",
        "dialog.commandFailed": "无法开始导出运行记录。",
      } : {
        "header.action": "Export run record",
        "dialog.preparingTitle": "Exporting run record",
        "dialog.preparingDescription": "Preparing a ZIP with this conversation, related conversations, and attachments.",
        "dialog.successTitle": "Run-record download started",
        "dialog.successDescription": "The browser is downloading the run-record ZIP.",
        "dialog.errorTitle": "Run-record export failed",
        "dialog.close": "Close",
        "dialog.commandFailed": "Could not export the run record.",
      }));
      disposers.push(ctx.locale.register("trajectory", localeId, zh ? {
        "view.trajectory": "运行记录",
        "toolbar.aria": "运行记录工具栏",
        "toolbar.search": "搜索运行记录",
        "history.loadingTrajectory": "正在加载运行记录…",
        "timeline.aria": "运行记录时间线",
        "tab.systemPrompt": "万象工作规则",
        "record.systemPromptMissing": "本次请求没有新增工作规则",
        "record.systemPrompt": "万象工作规则",
        "layout.initialSystemPrompt": "初始工作规则",
        "layout.systemPromptUpdated": "工作规则已更新",
        "layout.systemPromptAndToolsUpdated": "工作规则和能力已更新",
      } : {
        "view.trajectory": "Run record",
        "toolbar.aria": "Run-record toolbar",
        "toolbar.search": "Search run record",
        "history.loadingTrajectory": "Loading run record…",
        "timeline.aria": "Run-record timeline",
        "tab.systemPrompt": "Wanxiang work rules",
        "record.systemPromptMissing": "No new work rules for this request",
        "record.systemPrompt": "Wanxiang work rules",
        "layout.initialSystemPrompt": "Initial work rules",
        "layout.systemPromptUpdated": "Work rules updated",
        "layout.systemPromptAndToolsUpdated": "Work rules and capabilities updated",
      }));
      disposers.push(ctx.locale.register("chat", localeId, zh ? {
        "message.systemPrompt": "万象工作规则",
        "settings.transcript.normal": "完整",
        "settings.transcript.compact": "精简",
      } : {
        "message.systemPrompt": "Wanxiang work rules",
        "settings.transcript.normal": "Full",
        "settings.transcript.compact": "Compact",
      }));
      ctx.locale.setLocale(localeId);
      return () => { for (const dispose of disposers.reverse()) dispose(); };
    }

    const inject = ["slots", "sessions", "workspaces", "theme", "locale", "remote", "remote.credentials", "remote.llm", "remote.settings"];
    function apply(ctx) {
      rootContext = ctx;
      ctx.effect(() => installProductTitle(ctx), "万象页面标题");
      ctx.effect(() => ctx.theme.overrideTokens("@wanxiang/workbench", themeTokens), "万象主题");
      ctx.effect(() => installProductLocale(ctx), "万象产品语言");
      channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL_NAME) : null;
      if (channel) channel.onmessage = (event) => {
        const workspaceId = event.data?.workspaceId;
        if (typeof workspaceId === "string" && records.has(workspaceId)) void loadProject(workspaceId, true);
      };
      ctx.effect(() => () => channel?.close(), "万象跨窗口同步");
      ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.register({ name: "sidebar.brand.mark" }, Mark));
      ctx.slots.inject("sidebar.brand.name", () => ctx.slots.register({ name: "sidebar.brand.name" }, Name));
      ctx.slots.inject("conversation.hero.brand.mark", () => ctx.slots.register({ name: "conversation.hero.brand.mark" }, Mark));
      ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({ name: "conversation.input.dock", id: "wanxiang-guidance", order: -100 }, GuidanceDock));
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "wanxiang-community", order: 5 }, CommunityButton));
      ctx.slots.inject("shell.overlay", function* () {
        yield ctx.slots.register({ name: "shell.overlay", id: "wanxiang-styles", order: -100 }, ProductStyles);
        yield ctx.slots.register({ name: "shell.overlay", id: "wanxiang-overlay", order: 10 }, OverlayRoot);
      });
      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({ name: "conversation.session.header.actions", id: "wanxiang-work-brief", order: 10 }, HeaderBadge));
      ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({ name: "tool.call.toolview", key: "wanxiang_update_work_brief" }, WorkBriefToolView));
      ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({ name: "tool.call.toolview", key: "wanxiang_run_evaluation" }, ProxyRunToolView));
      ctx.slots.inject("settings.onboarding", function* () {
        yield ctx.slots.register({ name: "settings.onboarding", id: "welcome-notice", priority: -10, order: -100 }, NoWelcomeNotice);
        yield ctx.slots.register({ name: "settings.onboarding", id: "deepseek-official", priority: -10, order: -99 }, NoWelcomeNotice);
      });
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
