# dev-v0.7.2 改动清单

基于上游 `agegr/pi-web` v0.7.2，cherry-pick / 新增我们的改进。

---

## 🔴 P0 — 刚需

- [ ] **1. 上传文件 API** — `POST /api/files/upload` → 保存到 cwd，新做
- [ ] **2. ChatInput 上传按钮** — 📎 按钮 → 文件选择器 → 上传 → 插入路径
- [ ] **3. PNG 下载修复** — `Content-Disposition: inline` → `attachment`（对图片类型）

## 🟡 P1 — 重要

- [x] **4. 运行时版本号** — `app/api/version/route.ts` + ChatWindow VersionDisplay
- [x] **5. 项目目录不限数量** — 移除 `slice(0, 5)`，加滚动容器
- [x] **6. ToolsConfig 分组** — 扩展工具按 System/Project 分组
- [x] **6b. ToolsConfig 左右分栏** — 借鉴 PluginsConfig 的左列表+右详情布局
- [x] **6c. Tools 去重** — API 层按 name 去重，消除扩展工具重复
- [x] **7. ToolsConfig bug fix** — "Disable all" 三处修复

## 🟢 P2 — 锦上添花

- [ ] **8. PDF/DOCX 预览** — mammoth 支持 .docx 解析
- [ ] **9. LaTeX 数学渲染** — KaTeX + rehype-katex
- [x] **10. VersionDisplay** — 右下角版本号显示
- [ ] **11. HTML 表格边框** — 给表格加边框线

## ❌ 不做

| 功能 | 原因 |
|:----|:-----|
| 搜索 session | 两边都没有，非刚需 |
| compressTree | 上游已有，功能等价 |
| 智能自动滚动 | 上游已有 |
| IME 合成 | 上游已有 |
| Mermaid | 上游已有 |
| Session 导出 | 上游已有 |
| 扩展工具保留 | 上游已有 |
| 扩展模型加载 | 上游已有 |

---

## 操作顺序

```
 ✅ 运行时版本号       ← 已完成
 ✅ 项目目录不限数量    ← 已完成
 ✅ VersionDisplay     ← 随 #4 完成
 ✅ ToolsConfig 分组    ← 已完成
 ✅ ToolsConfig bug fix ← 已完成
 6️⃣ PNG 下载修复        ← 小修复
 7️⃣ 上传文件 API + UI   ← 新做
 8️⃣ PDF/DOCX 预览       ← 中等
 9️⃣ LaTeX               ← 中等
```

---

最后更新：2026-07-02
