const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    updatedBy: { type: String, default: 'system' },
    updatedAt: { type: Date, default: Date.now },
});

settingsSchema.index({ key: 1 });

// Helper: get a setting value with default
settingsSchema.statics.getValue = async function (key, defaultValue = null) {
    const doc = await this.findOne({ key });
    return doc ? doc.value : defaultValue;
};

// Helper: set a setting value
settingsSchema.statics.setValue = async function (key, value, updatedBy = 'system') {
    return this.findOneAndUpdate(
        { key },
        { $set: { value, updatedBy, updatedAt: new Date() } },
        { upsert: true, new: true }
    );
};

module.exports = mongoose.model('Settings', settingsSchema);
