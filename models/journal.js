const mongoose = require('mongoose');

const journalSchema = new mongoose.Schema({
    title: { type: String, required: true },
    category: { type: String, required: true },
    entry: { type: String, required: true },
    image: { type: String }, // Stores the filename of the uploaded image
    createdAt: { type: Date, default: Date.now },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } // Link to the user
});

module.exports = mongoose.model('Journal', journalSchema);
