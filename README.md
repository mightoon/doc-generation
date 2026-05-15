# 文档生成智能体

一个基于大语言模型的交互式长文档生成工具。用户通过浏览器与AI协作，逐步生成数百页级别的专业文档。

## 核心特性

- **三步向导式交互**：需求收集 → 大纲编辑 → 逐章生成
- **可视化大纲编辑**：支持添加、编辑、删除、排序章节
- **逐章流式生成**：WebSocket实时推送，看到内容逐步呈现
- **上下文感知**：自动将前序章节摘要作为上下文传入，保证文档连贯性
- **DOCX导出**：生成标准Word文档，包含封面、目录、正文

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置LLM接口

启动后通过页面右上角「配置」按钮设置，或通过环境变量：

```bash
# 环境变量方式
export LLM_BASE_URL="https://api.openai.com/v1"
export LLM_API_KEY="sk-your-key-here"
export LLM_MODEL="gpt-4o"

# 或使用兼容接口（如本地Ollama）
export LLM_BASE_URL="http://localhost:11434/v1"
export LLM_API_KEY="ollama"
export LLM_MODEL="qwen2.5:72b"
```

### 3. 启动服务

```bash
python app.py
```

服务默认运行在 `http://localhost:8765`

## 使用流程

1. **需求收集**：填写文档主题、类型、目标读者和详细需求描述
2. **大纲编辑**：AI生成大纲后，您可以双击标题编辑、添加/删除章节、调整结构
3. **内容生成**：确认大纲后，逐章点击生成，实时查看内容流式输出
4. **导出文档**：点击「导出」按钮下载DOCX文件

## 项目结构

```
├── app.py              # FastAPI主应用（REST API + WebSocket）
├── llm_client.py       # LLM客户端（OpenAI兼容接口）
├── doc_generator.py    # 文档生成逻辑（大纲+章节）
├── doc_exporter.py     # DOCX导出
├── requirements.txt    # Python依赖
├── static/
│   ├── index.html      # 单页应用
│   ├── style.css       # 样式
│   └── app.js          # 前端逻辑
└── README.md
```

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/config` | 更新LLM配置 |
| GET | `/api/config` | 获取当前LLM配置 |
| POST | `/api/session` | 创建会话 |
| GET | `/api/session/{id}` | 获取会话状态 |
| POST | `/api/generate-outline` | 生成文档大纲 |
| POST | `/api/update-outline` | 保存编辑后的大纲 |
| WS | `/ws/generate-chapter` | 流式生成章节内容 |
| GET | `/api/export-docx/{id}` | 导出DOCX文件 |

## 技术栈

- **后端**：Python 3.10+, FastAPI, uvicorn, openai
- **前端**：原生HTML/CSS/JS (无框架依赖)
- **文档导出**：python-docx
