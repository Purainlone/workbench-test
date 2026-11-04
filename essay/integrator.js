/* =====================================================================
   集成桥接层（integrator.js）
   作用：
   1) 解析 URL 参数（embed / studentId / studentName / mode），实现
      “小程序扫码识别学生 → 工作台自动定位该生” 的接入；
   2) 监听父页 / 小程序 web-view 的 postMessage（SCAN_STUDENT / LOAD_STUDENT）；
   3) 配合 app.js 暴露的 window.EssayGrader 完成加载与回传。
   本文件不依赖任何打包工具，原生 JS，直接 <script> 引入即可。
   ===================================================================== */
(function () {
  function getParam(k) { return new URLSearchParams(location.search).get(k); }

  function apply(studentId, mode) {
    if (!window.EssayGrader) return false;
    mode = (mode || 'students').toLowerCase();
    if (mode === 'grade') return window.EssayGrader.openGrade(studentId);
    if (mode === 'analyze') return window.EssayGrader.openAnalyze(studentId);
    return window.EssayGrader.loadStudent(studentId);
  }

  function onLoad() {
    // 1) iframe 嵌入模式：隐藏侧边栏/顶栏，仅显示内容区
    if (getParam('embed')) document.body.classList.add('embed');

    // 2) URL 参数方式（小程序扫码后打开 web-view 最常见、最稳的做法）
    const stuId = getParam('studentId');
    const mode = getParam('mode');
    if (stuId) {
      setTimeout(function () { apply(stuId, mode); }, 400);
    }

    // 3) 监听父页 / 小程序下发的扫码结果（实时联动）
    window.addEventListener('message', function (ev) {
      var d = ev.data || {};
      if (d.type === 'SCAN_STUDENT' || d.type === 'LOAD_STUDENT') {
        if (d.studentId && window.EssayGrader) {
          apply(d.studentId, d.mode || mode || 'students');
          if (window.EssayGrader._notify) window.EssayGrader._notify('scan', { studentId: d.studentId, studentName: d.studentName });
        }
      }
      /* 2.6.88 宿主收稿箱「去批改」：学生+标题+原文照片一次性带入批改工作台 */
      if (d.type === 'PREFILL_GRADE' && window.EssayGrader && window.EssayGrader.prefillGrade) {
        try { window.EssayGrader.prefillGrade(d) } catch (e) {}
      }
      /* vT48 宿主模型库「⬇️ 部署到批改台」：把选中的自定义模型写入批改模型配置并启用 */
      if (d.type === 'WB_DEPLOY_MODEL' && window.EssayGrader && window.EssayGrader.applyWbModel) {
        try { window.EssayGrader.applyWbModel(d.model || {}) } catch (e) {}
      }
    });
  }

  /* 4) v1.1 宿主工作台桥接：父页下发真实花名册（整体替换演示学生） */
  window.addEventListener('message', function (ev) {
    var d = ev.data || {};
    if (d && d.type === 'WB_SET_STUDENTS' && Array.isArray(d.students) && window.EssayGrader) {
      try { window.EssayGrader.replaceStudents(d.students) } catch (e) {}
    }
  });

  if (document.readyState !== 'loading') onLoad();
  else document.addEventListener('DOMContentLoaded', onLoad);
})();
