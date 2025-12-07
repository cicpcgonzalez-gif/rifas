const express = require('express');
const router = express.Router();
const prisma = require('../config/database');
const authMiddleware = require('../middleware/auth');

// Get all raffles - Protected route
router.get('/', authMiddleware, async (req, res) => {
  try {
    const raffles = await prisma.raffle.findMany({
      orderBy: {
        createdAt: 'desc'
      }
    });
    res.status(200).json(raffles);
  } catch (error) {
    console.error('Error fetching raffles:', error);
    res.status(500).json({ error: 'Failed to fetch raffles' });
  }
});

// Get single raffle - Protected route
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const raffle = await prisma.raffle.findUnique({
      where: { id: req.params.id }
    });
    
    if (!raffle) {
      return res.status(404).json({ error: 'Raffle not found' });
    }
    
    res.status(200).json(raffle);
  } catch (error) {
    console.error('Error fetching raffle:', error);
    res.status(500).json({ error: 'Failed to fetch raffle' });
  }
});

// Create raffle - Protected route
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { title, description, price, totalTickets } = req.body;
    
    if (!title || !price || !totalTickets) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate numeric inputs
    const parsedPrice = parseFloat(price);
    const parsedTickets = parseInt(totalTickets, 10);

    if (isNaN(parsedPrice) || parsedPrice <= 0) {
      return res.status(400).json({ error: 'Price must be a valid positive number' });
    }

    if (isNaN(parsedTickets) || parsedTickets <= 0) {
      return res.status(400).json({ error: 'Total tickets must be a valid positive integer' });
    }
    
    const raffle = await prisma.raffle.create({
      data: {
        title,
        description,
        price: parsedPrice,
        totalTickets: parsedTickets
      }
    });
    
    res.status(201).json(raffle);
  } catch (error) {
    console.error('Error creating raffle:', error);
    res.status(500).json({ error: 'Failed to create raffle' });
  }
});

// Update raffle - Protected route
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { title, description, price, totalTickets, status } = req.body;
    
    // Validate numeric inputs if provided
    if (price !== undefined) {
      const parsedPrice = parseFloat(price);
      if (isNaN(parsedPrice) || parsedPrice <= 0) {
        return res.status(400).json({ error: 'Price must be a valid positive number' });
      }
    }

    if (totalTickets !== undefined) {
      const parsedTickets = parseInt(totalTickets, 10);
      if (isNaN(parsedTickets) || parsedTickets <= 0) {
        return res.status(400).json({ error: 'Total tickets must be a valid positive integer' });
      }
    }

    const raffle = await prisma.raffle.update({
      where: { id: req.params.id },
      data: {
        ...(title && { title }),
        ...(description !== undefined && { description }),
        ...(price && { price: parseFloat(price) }),
        ...(totalTickets && { totalTickets: parseInt(totalTickets, 10) }),
        ...(status && { status })
      }
    });
    
    res.status(200).json(raffle);
  } catch (error) {
    console.error('Error updating raffle:', error);
    // Handle Prisma not found error
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Raffle not found' });
    }
    res.status(500).json({ error: 'Failed to update raffle' });
  }
});

// Delete raffle - Protected route
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await prisma.raffle.delete({
      where: { id: req.params.id }
    });
    
    res.status(200).json({ message: 'Raffle deleted successfully' });
  } catch (error) {
    console.error('Error deleting raffle:', error);
    // Handle Prisma not found error
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Raffle not found' });
    }
    res.status(500).json({ error: 'Failed to delete raffle' });
  }
});

module.exports = router;
