// The same model definitions for Sequelize v6 and v7, so v6 vs v7 compares the library only.
// Called with (sequelize, { DataTypes, Op, literal }) from 'sequelize' (v6), 'sequelize-cockroachdb', 'sequelize-dm8' or '@sequelize/core' (v7).
export function defineModels(sequelize, { DataTypes, Op, literal }) {
  const opts = (tableName) => ({ tableName, timestamps: false });
  const User = sequelize.define('User', {
    id: { type: DataTypes.UUID, primaryKey: true },
    email: DataTypes.TEXT,
    username: DataTypes.STRING,
    firstName: DataTypes.STRING,
    lastName: DataTypes.STRING,
    organizationId: DataTypes.UUID,
    preferredLanguage: DataTypes.STRING,
  }, opts('Users'));
  const Role = sequelize.define('Role', {
    id: { type: DataTypes.UUID, primaryKey: true },
    key: DataTypes.STRING,
    name: DataTypes.STRING,
    priority: DataTypes.INTEGER,
  }, opts('Roles'));
  const UserRole = sequelize.define('UserRole', {
    id: { type: DataTypes.UUID, primaryKey: true },
    userId: DataTypes.UUID,
    roleId: DataTypes.UUID,
    isActive: DataTypes.BOOLEAN,
    expiresAt: DataTypes.DATE,
  }, opts('UserRoles'));
  const Item = sequelize.define('Item', {
    id: { type: DataTypes.UUID, primaryKey: true },
    type: DataTypes.STRING,
    isPublic: DataTypes.BOOLEAN,
    isActive: DataTypes.BOOLEAN,
    displayOrder: DataTypes.INTEGER,
    createdAt: DataTypes.DATE,
  }, opts('Items'));
  const ItemTranslation = sequelize.define('ItemTranslation', {
    id: { type: DataTypes.UUID, primaryKey: true },
    itemId: DataTypes.UUID,
    language: DataTypes.STRING,
    name: DataTypes.STRING,
  }, opts('ItemTranslations'));
  const Message = sequelize.define('Message', {
    id: { type: DataTypes.UUID, primaryKey: true },
    userId: DataTypes.UUID,
    type: DataTypes.STRING,
    title: DataTypes.STRING,
    isRead: DataTypes.BOOLEAN,
    createdAt: DataTypes.DATE,
  }, opts('Messages'));
  const Link = sequelize.define('Link', {
    id: { type: DataTypes.UUID, primaryKey: true },
    userId: DataTypes.UUID,
    otherId: DataTypes.UUID,
    status: DataTypes.STRING,
  }, opts('Links'));

  User.belongsToMany(Role, {
    through: {
      model: UserRole,
      unique: false,
      scope: { isActive: true, [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: literal('NOW()') } }] },
    },
    foreignKey: 'userId', otherKey: 'roleId', as: 'roles',
  });
  Item.hasMany(ItemTranslation, { as: 'translations', foreignKey: 'itemId' });

  return { User, Role, UserRole, Item, ItemTranslation, Message, Link };
}
