import express from "express";
import mongoose from "mongoose";
import Item from "./models/Item.js";
import bodyParser from "body-parser";
import multer from "multer";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import fs from "fs";
import sharp from "sharp";
import axios from "axios";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const API_KEY = process.env.OPENAI_API_KEY;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Middlewares ----------
app.use(
  cors({
    origin: "http://localhost:5173",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use("/uploads", express.static("uploads"));

// ---------- MongoDB Connection ----------
mongoose.connect(process.env.MONGO_URI);

// ---------- Multer Config ----------
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// ---------- Utility ----------
const sanitizePrompt = (prompt) => {
  const noImagePrompt = prompt.replace(
    /<img[^>]+src="data:image\/[^">]+"[^>]*>/g,
    "[image]"
  );
  const words = noImagePrompt.split(/\s+/);
  return words.length > 1000 ? words.slice(0, 1000).join(" ") : noImagePrompt;
};

// ---------- Routes ----------

// Root check
app.get("/", (req, res) => {
  res.send("Server with OpenAI + MongoDB API is running.");
});

// ===== OpenAI Proxy =====
app.post("/openai-api/openai", async (req, res) => {
  const { prompt } = req.body;
  try {
    const trimmedPrompt = sanitizePrompt(prompt);

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: trimmedPrompt }],
        max_tokens: 300,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("OpenAI Error:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.error?.message || "Something went wrong",
    });
  }
});

// ===== Blog/Item APIs =====
app.post("/api/senddocument", upload.single("image"), async (req, res) => {
  try {
    let imageUrl = null;
    if (req.file) {
      imageUrl = `${req.protocol}://${req.get("host")}/uploads/${
        req.file.filename
      }`;
    }
    const { title, content, summary } = req.body;
    await Item.insertMany([{ title, content, imageUrl, summary }]);
    res.status(200).json({ message: "Document sent", imageUrl });
  } catch (error) {
    console.log(error.message);
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/upload-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) throw new Error("No file uploaded");
    const filePath = path.join(__dirname, "uploads", req.file.filename);

    try {
      const processedImage = await sharp(filePath)
        .toFormat("jpeg")
        .jpeg({ quality: 80 })
        .toBuffer();

      const base64Image = processedImage.toString("base64");
      const dataURI = `data:image/jpeg;base64,${base64Image}`;
      fs.unlinkSync(filePath);

      res.status(200).json({
        data: { files: [dataURI], base64: dataURI, success: true },
      });
    } catch (processingError) {
      console.error("Image processing failed:", processingError);
      const fileData = fs.readFileSync(filePath);
      const base64Image = fileData.toString("base64");
      const dataURI = `data:${req.file.mimetype};base64,${base64Image}`;
      fs.unlinkSync(filePath);

      res.status(200).json({
        data: { files: [dataURI], base64: dataURI, success: true },
      });
    }
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({
      data: {
        messages: ["Failed to process image. Please try a different format."],
        files: [],
        success: false,
      },
    });
  }
});

app.get("/api/items", async (req, res) => {
  try {
    const items = await Item.find({}, "title content summary");
    res.json(items);
  } catch (error) {
    console.error(error);
    res.status(500).send("Server Error");
  }
});

app.get("/api/items/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const item = await Item.findById(id);
    if (!item) return res.status(404).json({ message: "Item not found" });
    res.json(item);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.put("/api/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, summary } = req.body;
    await Item.updateOne({ _id: id }, { $set: { title, content, summary } });
    res.status(200).json({ message: "Successfully updated the Blog!" });
  } catch (error) {
    console.log({ Error: error.message });
    res.status(500).json({ error: "Update failed" });
  }
});

app.delete("/api/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await Item.deleteOne({ _id: id });
    if (result.deletedCount == 0)
      return res.status(404).json({ message: "Blog not found." });
    res.status(200).json({ message: "Successfully deleted the blog!" });
  } catch (error) {
    console.log({ Error: error.message });
    res.status(500).json({ error: "Something went wrong while deleting" });
  }
});

app.post("/api/feedbackpost/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const feedback = req.body.updatePOCfeedbacks;
    const result = await Item.updateOne(
      { _id: id },
      { $push: { feedback: { $each: feedback } } }
    );
    res.status(200).json({ message: "Feedback added", result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error while adding feedback!" });
  }
});

// ---------- Start Server ----------
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
