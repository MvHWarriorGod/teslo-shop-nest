import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Product } from './entities/product.entity';
import { PaginationDto } from 'src/common/dtos/pagination.dto';
import { validate as isUUID } from 'uuid';
import { ProductImage } from './entities/product-image.entity';
import { error } from 'console';

@Injectable()
export class ProductsService {
  // para ver los log de un aforma mas amigable
  private logger = new Logger('ProductsService');

  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,

    @InjectRepository(ProductImage)
    private readonly productImageRepository: Repository<ProductImage>,

    private readonly dataSource: DataSource,
  ) {}

  async create(createProductDto: CreateProductDto) {
    try {
      const { images = [], ...productDetails } = createProductDto;
      const product = this.productRepository.create({
        ...productDetails,
        // Guardar las ias imagenes en la tabla imagenes
        images: images.map((image) =>
          this.productImageRepository.create({ url: image }),
        ),
      });
      // aqui esperamos que guarden los datos en ambas tablas
      await this.productRepository.save(product);

      return { ...product, images };
    } catch (error) {
      this.handleDBException(error);
    }
  }

  async findAll(paginationDto: PaginationDto) {
    const { limit = 10, offset = 0 } = paginationDto;

    const products = await this.productRepository.find({
      take: limit,
      skip: offset,
      // para que al listar se muestre la relacion
      relations: {
        images: true,
      },
    });

    // para retornar solo la url de la imagen en lugar de la ulr y el id como me devuelve la relacion
    return products.map(({ images, ...rest }) => ({
      ...rest,
      images: images.map((img) => img.url),
    }));
  }

  async findOne(term: string) {
    let product: Product;

    if (isUUID(term)) {
      product = await this.productRepository.findOneBy({ id: term });
    } else {
      const queryBuilder = this.productRepository.createQueryBuilder('prod'); // el alias de la tabla es prod
      product = await queryBuilder
        .where('UPPER(title) =:title or slug=:slug', {
          title: term.toUpperCase(),
          slug: term.toLowerCase(),
        })
        // Cuando no es un find entonces debo de usar un leftJoinAndSelect para que seleccione los datos de la tabla que tiene relacion con esta
        .leftJoinAndSelect('prod.images', 'prodImages')
        .getOne();
    }

    if (!product)
      throw new NotFoundException(`Product with  ${term} not found`);
    console.log({ product });
    return product;
  }

  async findOnePlain(term: string) {
    const { images = [], ...rest } = await this.findOne(term);
    return {
      ...rest,
      images: images.map((image) => image.url),
    };
  }

  async update(id: string, updateProductDto: UpdateProductDto) {
    const { images, ...toUpdate } = updateProductDto;

    const product = await this.productRepository.preload({
      id,
      ...toUpdate,
    });

    if (!product)
      throw new NotFoundException(`Product with id: ${id} not found`);

    // Create query runner
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      if (images) {
        // ElimZinar las imagenes anteriores relacionadas a ese id si es que viene nuevas imagenes en el updateProductDto
        await queryRunner.manager.delete(ProductImage, { product: { id } });
        // Instanciar  las nuevas imagenes
        product.images = images.map((image) =>
          this.productImageRepository.create({ url: image }),
        );
      }
      // intenta grabarlo si es que ambas consultas salieron exirtosas
      await queryRunner.manager.save(product);

      // gaurdar
      await queryRunner.commitTransaction();

      // cerrar la conexion
      await queryRunner.release();

      // asi seria solo guardar si no hubiera el query builder
      // await this.productRepository.save(product);
      const result = await this.findOnePlain(id);
      console.log(result);
      return result;
    } catch (error) {
      // si existe un error hacer el rollback
      queryRunner.rollbackTransaction();
      await queryRunner.release();

      // retornar los errores y excepciones de nest
      this.handleDBException(error);
    }
  }

  async remove(id: string) {
    const product = await this.findOne(id);
    await this.productRepository.remove(product);
  }

  private handleDBException(error: any) {
    if (error.code === '23505') throw new BadRequestException(error.detail);
    this.logger.error(error);
    throw new InternalServerErrorException(
      'Unexpected error, check server logs',
    );
  }

  async deleteAllPRoducts() {
    const query = this.productRepository.createQueryBuilder('product');

    try {
      return await query.delete().where({}).execute();
    } catch (error) {}
    this.handleDBException(error);
  }
}
