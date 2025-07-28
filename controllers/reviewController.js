const Review = require('../models/Review');

// CREATE
exports.createReview = async (req, res) => {
  try {
    const review = await Review.create(req.body);
    res.status(201).json(review);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// READ ALL
exports.getAllReviews = async (req, res) => {
  try {
    const reviews = await Review.find().populate('user');
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// READ BY USER
exports.getReviewsByUserId = async (req, res) => {
  try {
    const reviews = await Review.find({ user: req.params.userid }).populate('user');
    if (!reviews || reviews.length === 0)
      return res.status(404).json({ message: "No reviews found for this user" });
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// UPDATE
exports.updateReview = async (req, res) => {
  try {
    const service = await Review.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!service) return res.status(404).json({ message: "Review not found" });
    res.json(service);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// DELETE
exports.deleteReview = async (req, res) => {
  try {
    const review = await Review.findByIdAndDelete(req.params.id);
    if (!review) return res.status(404).json({ message: "Review not found" });
    res.json({ message: "Review deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};