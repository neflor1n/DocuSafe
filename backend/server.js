const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const multer = require("multer");
const path = require("path");
const cors = require("cors");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static(path.resolve("uploads")));
app.use(express.static(path.resolve("frontend")));

app.get("/", (req, res) => {
  res.sendFile(path.resolve("frontend/index.html"));
});

const db = new sqlite3.Database("docusafe.db");

// Инициализация базы данных
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    UNIQUE(user_id, name),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    folder_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    tags TEXT,
    share_id TEXT UNIQUE,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(folder_id) REFERENCES folders(id)
  )`);
});

// Регистрация
app.post("/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: "Введите логин и пароль" });
  const hash = bcrypt.hashSync(password, 10);
  db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, hash], function (err) {
    if (err) return res.status(400).json({ message: "Пользователь уже существует" });
    res.json({ message: "Пользователь зарегистрирован" });
  });
});

// Логин
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  db.get("SELECT id, password FROM users WHERE username = ?", [username], (err, row) => {
    if (err || !row) return res.status(401).json({ message: "Неверное имя пользователя" });
    if (!bcrypt.compareSync(password, row.password)) return res.status(401).json({ message: "Неверный пароль" });
    res.json({ message: "Успешный вход", user_id: row.id });
  });
});

// Создание папки
app.post("/create-folder", (req, res) => {
  const { user_id, folderName } = req.body;
  if (!user_id || !folderName) return res.status(400).json({ message: "Недопустимые данные" });

  const dirPath = path.join("uploads", folderName);
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

  db.run("INSERT OR IGNORE INTO folders (user_id, name) VALUES (?, ?)", [user_id, folderName], function (err) {
    if (err) return res.status(500).json({ message: "Ошибка создания папки в базе" });
    res.json({ message: "Папка создана или уже существует" });
  });
});

// Получение всех папок
app.get("/folders", (req, res) => {
  const { user_id } = req.query;
  db.all("SELECT id, name FROM folders WHERE user_id = ?", [user_id], (err, rows) => {
    if (err) return res.status(500).json({ message: "Ошибка получения папок" });
    res.json(rows);
  });
});

// Загрузка файлов
app.post("/upload", upload.single("file"), (req, res) => {
  const { user_id, tags, folder_id } = req.body;
  if (!req.file || !user_id || !folder_id) return res.status(400).json({ message: "Данные неполные" });

  const share_id = uuidv4();

  db.get("SELECT name FROM folders WHERE id = ? AND user_id = ?", [folder_id, user_id], (err, folderRow) => {
    if (err || !folderRow) return res.status(400).json({ message: "Папка не найдена" });

    const folderName = folderRow.name;
    const targetDir = path.join("uploads", folderName);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const targetPath = path.join(targetDir, req.file.originalname);

    fs.rename(req.file.path, targetPath, err => {
      if (err) return res.status(500).json({ message: "Ошибка сохранения файла" });

      db.run(
        "INSERT INTO documents (user_id, folder_id, filename, filepath, tags, share_id) VALUES (?, ?, ?, ?, ?, ?)",
        [user_id, folder_id, req.file.originalname, targetPath, tags, share_id],
        err => {
          if (err) return res.status(500).json({ message: "Ошибка записи в БД" });
          res.json({ message: "Файл загружен успешно", share_id });
        }
      );
    });
  });
});

// Получение файлов
app.get("/documents", (req, res) => {
  const { user_id, folder_id } = req.query;
  db.all("SELECT * FROM documents WHERE user_id = ? AND folder_id = ?", [user_id, folder_id], (err, rows) => {
    if (err) return res.status(500).json({ message: "Ошибка получения документов" });
    res.json(rows);
  });
});

// Удаление файла
app.delete("/documents/:id", (req, res) => {
  const docId = req.params.id;
  db.get("SELECT filepath FROM documents WHERE id = ?", [docId], (err, row) => {
    if (err || !row) return res.status(404).json({ message: "Файл не найден" });

    fs.unlink(row.filepath, err => {
      if (err) console.warn("Файл уже удалён или отсутствует:", err.message);
    });

    db.run("DELETE FROM documents WHERE id = ?", [docId], err => {
      if (err) return res.status(500).json({ message: "Ошибка удаления из базы" });
      res.json({ message: "Файл удалён" });
    });
  });
});

// Публичный просмотр
app.get("/share/:share_id", (req, res) => {
  const { share_id } = req.params;
  db.get("SELECT filepath FROM documents WHERE share_id = ?", [share_id], (err, row) => {
    if (err || !row) return res.status(404).json({ message: "Файл не найден" });
    res.sendFile(path.resolve(row.filepath));
  });
});

app.listen(PORT, () => {
  console.log(`✅ DocuSafe backend работает на http://localhost:${PORT}`);
});
