require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Models
const User = require('./models/User');
const Journal = require('./models/Journal');

const app = express();
const PORT = process.env.PORT || 3000;

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ Successfully connected to MongoDB Atlas!");
    
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error("❌ MongoDB connection error:", err);
  });
// --- MIDDLEWARE ---
app.use(express.urlencoded({ extended: true })); // Parse form data
app.use(express.json());

// Serve static assets from absolute paths (ensure correct resolution regardless of CWD)
app.use(express.static(path.join(__dirname, 'public'))); // Serve CSS/Images from /public
app.use('/uploads', express.static(path.join(__dirname, 'uploads'))); // Serve uploaded images

// Ensure Express looks for views in the project's views folder
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Simple request logger to help debug missing files/routes
app.use((req, res, next) => {
    console.log(`[REQ] ${req.method} ${req.path}`);
    next();
});

// Session Config (Login memory)
// Replace direct MongoStore.create(...) with a compatibility layer:
// Session Config
// 1. Define the session options and attach the MongoStore
const sessionOptions = {
    secret: process.env.SESSION_SECRET || 'secret key',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: process.env.MONGO_URI,
        collectionName: 'sessions' 
    })
};

app.use(session(sessionOptions));

// File Upload Config (Multer)
const storage = multer.diskStorage({
    destination: path.join(__dirname, 'uploads'),
    filename: function(req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// --- AUTH MIDDLEWARE (Protect Routes) ---
const requireLogin = (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    next();
};

// --- ROUTES ---

// 1. Public Pages
app.get('/', (req, res) => res.render('index'));
app.get('/login', (req, res) => res.render('login'));
app.get('/register', (req, res) => res.render('register'));

// 2. Authentication Logic
app.post('/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        // Basic check if user exists
        const existingUser = await User.findOne({ email });
        if (existingUser) return res.send("User already exists. <a href='/login'>Login</a>");

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        await User.create({ name, email, password: hashedPassword });
        
        res.redirect('/login');
    } catch (error) {
        console.error(error);
        res.status(500).send("Error registering user");
    }
});

app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.userId = user._id; // Save login session
            req.session.userName = user.name;
            return res.redirect('/dashboard');
        }
        res.redirect('/login'); // Add error handling in real app
    } catch (error) {
        console.error(error);
        res.status(500).send("Server Error");
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// 3. Dashboard (Protected)
app.get('/dashboard', requireLogin, async (req, res) => {
    try {
        // Find journals belonging to THIS user, sorted by newest
        const journals = await Journal.find({ user: req.session.userId }).sort({ createdAt: -1 });
        
        res.render('dashboard', { 
            user: req.session.userName,
            journals: journals 
        });
    } catch (error) {
        res.status(500).send("Error loading dashboard");
    }
});

// 4. Create Journal (Protected)
app.get('/create-journal', requireLogin, (req, res) => {
    res.render('create-journal');
});

app.post('/api/v1/journals', requireLogin, upload.single('image'), async (req, res) => {
    try {
        const { title, category, entry } = req.body;
        
        await Journal.create({
            title,
            category,
            entry,
            image: req.file ? req.file.filename : null,
            user: req.session.userId
        });
        
        res.redirect('/dashboard');
    } catch (error) {
        console.error(error);
        res.status(500).send("Error creating journal");
    }
});

// Dynamic page fallback:
// If a user clicks a link from index.ejs to e.g. "/about" and there's an about.ejs view, render it.
// Place after your explicit routes so it doesn't override them.
app.get('/:page', (req, res, next) => {
    const page = req.params.page;
    // block reserved prefixes to avoid interfering with APIs/static
    const reserved = ['api', 'uploads', 'css', 'js', 'images', 'favicon.ico', 'logout', 'login', 'register', 'dashboard', 'create-journal'];
    if (reserved.includes(page)) return next();

    const viewPath = path.join(__dirname, 'views', `${page}.ejs`);
    if (fs.existsSync(viewPath)) {
        return res.render(page);
    }
    next(); // allow 404 or other middleware to handle it
});

// Optional: simple 404 handler (last middleware)
app.use((req, res) => {
    res.status(404).send('Not found');
});
