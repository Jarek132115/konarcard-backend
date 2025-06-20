const Service = require('../models/Service');

// CREATE
exports.createService = async (req, res) => {
  try {
    const service = await Service.create(req.body);
    res.status(201).json(service);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// CREATE MULTIPLE SERVICES
exports.createMultipleServices = async (req, res) => {
  try {
    const services = req.body.services;

    if (!Array.isArray(services) || services.length === 0) {
      return res.status(400).json({ error: 'Please provide an array of services.' });
    }

    const createdServices = await Service.insertMany(services);
    res.status(201).json({ message: 'Services created successfully', data: createdServices });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};


// READ ALL
exports.getAllServices = async (req, res) => {
  try {
    const services = await Service.find().populate('user');
    res.json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// READ SINGLE
exports.getServiceById = async (req, res) => {
  try {
    const service = await Service.findById(req.params.id).populate('user');
    if (!service) return res.status(404).json({ message: "Service not found" });
    res.json(service);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// READ ALL SERVICES BY USER ID
exports.getServiceByUserId = async (req, res) => {
  try {
    const services = await Service.find({ user: req.params.userid }).populate('user');
    if (!services || services.length === 0)
      return res.status(404).json({ message: "No services found for this user" });

    res.json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};


// UPDATE
exports.updateService = async (req, res) => {
  try {
    const service = await Service.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!service) return res.status(404).json({ message: "Service not found" });
    res.json(service);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// DELETE
exports.deleteService = async (req, res) => {
  try {
    const service = await Service.findByIdAndDelete(req.params.id);
    if (!service) return res.status(404).json({ message: "Service not found" });
    res.json({ message: "Service deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
