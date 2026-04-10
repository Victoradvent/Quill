require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const methodOverride = require('method-override');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

// Models
const User = require('./models/user');
const Journal = require('./models/journal');

const app = express();
const PORT = process.env.PORT || 3000;

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log(" Successfully connected to MongoDB Atlas!");
    
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
app.use(express.static('public')); 
app.use('/uploads', express.static('uploads'));
app.use(methodOverride('_method')); // Enables PUT and DELETE requests
app.set('view engine', 'ejs');

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
        
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.render('login', { error: "Invalid email or password." });
        }
        
        req.session.userId = user._id;
        req.session.userName = user.name;
        res.redirect('/dashboard');
    } catch (error) {
        res.status(500).send("Server Error");
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// --- PASSWORD RESET ROUTES ---
app.get('/forgot-password', (req, res) => res.render('forgot-password', { error: null, success: null }));

app.post('/forgot-password', async (req, res) => {
    const user = await User.findOne({ email: req.body.email });
    if (!user) return res.render('forgot-password', { error: 'No account with that email exists.', success: null });

    const token = crypto.randomBytes(20).toString('hex');
    user.resetPasswordToken = token;
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hour
    await user.save();

    const resetURL = `http://${req.headers.host}/reset/${token}`;
    const mailOptions = {
        to: user.email,
        from: 'noreply@quill.com',
        subject: 'Quill Password Reset',
        text: `You requested a password reset. Click here to reset it: \n\n ${resetURL}`
    };

    transporter.sendMail(mailOptions, (err) => {
        res.render('forgot-password', { error: null, success: 'An e-mail has been sent with further instructions.' });
    });
});

app.get('/reset/:token', async (req, res) => {
    const user = await User.findOne({ resetPasswordToken: req.params.token, resetPasswordExpires: { $gt: Date.now() } });
    if (!user) return res.send('Password reset token is invalid or has expired.');
    res.render('reset-password', { token: req.params.token, error: null });
});

app.post('/reset/:token', async (req, res) => {
    const user = await User.findOne({ resetPasswordToken: req.params.token, resetPasswordExpires: { $gt: Date.now() } });
    if (!user) return res.render('reset-password', { token: req.params.token, error: 'Token expired.' });

    user.password = await bcrypt.hash(req.body.password, 10);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();
    res.redirect('/login');
});

// --- DASHBOARD (Protected & Searchable) ---
app.get('/dashboard', requireLogin, async (req, res) => {
    try {
        let query = { user: req.session.userId };

        // Search and Filter Logic
        if (req.query.search) query.title = { $regex: req.query.search, $options: 'i' };
        if (req.query.category && req.query.category !== 'All') query.category = req.query.category;

        const journals = await Journal.find(query).sort({ createdAt: -1 });
        
        res.render('dashboard', { user: req.session.userName, journals: journals });
    } catch (error) {
        res.status(500).send("Error loading dashboard");
    }
});

// --- JOURNAL CRUD ROUTES ---
app.get('/create-journal', requireLogin, (req, res) => res.render('create-journal'));

app.post('/api/v1/journals', requireLogin, upload.single('image'), async (req, res) => {
    try {
        const { title, category, entry } = req.body;
        await Journal.create({ title, category, entry, image: req.file ? req.file.filename : null, user: req.session.userId });
        res.redirect('/dashboard');
    } catch (error) {
        res.status(500).send("Error creating journal");
    }
});

app.get('/edit-journal/:id', requireLogin, async (req, res) => {
    const journal = await Journal.findOne({ _id: req.params.id, user: req.session.userId });
    if (!journal) return res.redirect('/dashboard');
    res.render('edit-journal', { journal });
});

app.put('/api/v1/journals/:id', requireLogin, async (req, res) => {
    try {
        const { title, category, entry } = req.body;
        await Journal.findOneAndUpdate({ _id: req.params.id, user: req.session.userId }, { title, category, entry });
        res.redirect('/dashboard');
    } catch (error) {
        res.status(500).send("Error updating journal");
    }
});

app.delete('/api/v1/journals/:id', requireLogin, async (req, res) => {
    try {
        await Journal.findOneAndDelete({ _id: req.params.id, user: req.session.userId });
        res.redirect('/dashboard');
    } catch (error) {
        res.status(500).send("Error deleting journal");
    }
});

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

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
